const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const electronBinary = require('electron');

const desktopDir = path.resolve(__dirname, '..');
const rootDir = path.resolve(desktopDir, '..');
const frontendDir = path.join(rootDir, 'frontend');
const rendererUrl = 'http://127.0.0.1:5173';
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let vite;
let electron;
let shuttingDown = false;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitForClose(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => child.once('close', () => resolve(true)));
}

// 按平台终止进程或进程树，避免 npm 启动的子进程残留。
function sendSignal(child, signal, tree, force = false) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    const args = ['/pid', String(child.pid), '/T'];
    if (force) {
      args.push('/F');
    }
    spawn('taskkill', args, { stdio: 'ignore' }).once('error', () => {});
  } else if (tree || force) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') {
        child.kill(signal);
      }
    }
  } else {
    child.kill(signal);
  }
}

async function stopChild(child, tree) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = waitForClose(child);
  sendSignal(child, 'SIGTERM', tree);
  const exited = await Promise.race([closed, delay(5000).then(() => false)]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    sendSignal(child, 'SIGKILL', tree, true);
    await Promise.race([closed, delay(2000)]);
  }
}

// 防止重复退出，并等待两个子进程清理后再结束开发脚本。
async function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await Promise.all([stopChild(electron, false), stopChild(vite, true)]);
  process.exit(exitCode);
}

function watch(child, name) {
  child.once('error', (error) => {
    console.error(`[dev] ${name} 启动失败：${error.message}`);
    shutdown(1);
  });
  child.once('exit', (code, signal) => {
    console.log(`[dev] ${name} 退出：code=${code} signal=${signal}`);
    shutdown(code ?? (signal ? 1 : 0));
  });
}

// 轮询页面地址，避免 Vite 未就绪时 Electron 加载失败。
function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(url, {}, (response) => {
        response.resume();
        resolve();
      });
      request.on('error', () => {
        if (Date.now() >= deadline) {
          reject(new Error(`Vite 未就绪超时：${url}`));
        } else {
          setTimeout(probe, 50);
        }
      });
    };
    probe();
  });
}

// 分配后端端口，并通过共享环境变量联动 Vite 与 Electron。
async function main() {
  const backendPort = await getFreePort();
  const env = {
    ...process.env,
    AEROAGENT_BACKEND_PORT: String(backendPort),
    VITE_API_PROXY_TARGET: `http://127.0.0.1:${backendPort}`,
    ELECTRON_RENDERER_URL: rendererUrl,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  console.log(`[dev] 后端端口 ${backendPort}，页面 ${rendererUrl}`);
  vite = spawn(npmCommand, [
    '--prefix', frontendDir, 'run', 'dev', '--', '--host', '127.0.0.1', '--strictPort',
  ], {
    cwd: rootDir,
    env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
  const viteReadyTimeout = Number(process.env.AEROAGENT_VITE_READY_TIMEOUT_MS || 30000);
  try {
    await waitForUrl(rendererUrl, viteReadyTimeout);
  } catch (error) {
    console.error(`[dev] ${error.message}`);
    await shutdown(1);
    return;
  }
  electron = spawn(electronBinary, ['.'], {
    cwd: desktopDir,
    env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
  watch(vite, 'Vite');
  watch(electron, 'Electron');
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
main().catch((error) => {
  console.error(`[dev] ${error.stack || error}`);
  shutdown(1);
});
