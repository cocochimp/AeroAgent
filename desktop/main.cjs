const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const healthTimeoutMs = 60_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let mainWindow;
let backend;
let backendError;
let backendLog;
let cleanupPromise;
let stopping = false;

app.setName('AeroAgent');

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(`[desktop] ${message}`);
  if (backendLog && !backendLog.destroyed && backendLog.writable) {
    backendLog.write(`${line}\n`);
  }
}

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

async function getBackendPort() {
  if (!process.env.AEROAGENT_BACKEND_PORT) {
    return getFreePort();
  }
  const port = Number(process.env.AEROAGENT_BACKEND_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('AEROAGENT_BACKEND_PORT 不是有效端口');
  }
  return port;
}

function backendCommand(port) {
  if (!app.isPackaged) {
    return {
      command: 'uv',
      args: ['run', 'uvicorn', 'app.api.main:app', '--host', '127.0.0.1', '--port', String(port)],
      cwd: rootDir,
    };
  }
  const executable = process.platform === 'win32' ? 'aeroagent-api.exe' : 'aeroagent-api';
  return {
    command: path.join(process.resourcesPath, 'backend', 'aeroagent-api', executable),
    args: ['--host', '127.0.0.1', '--port', String(port)],
    cwd: path.join(process.resourcesPath, 'backend'),
  };
}

// 启动独立后端进程，并接入日志与意外退出处理。
function startBackend(port) {
  const { command, args, cwd } = backendCommand(port);
  const env = { ...process.env };
  if (app.isPackaged) {
    const userData = app.getPath('userData');
    env.AEROAGENT_USER_DATA = userData;
    env.AEROAGENT_WEB_DIST = path.join(process.resourcesPath, 'frontend', 'dist');
    env.AIR_VAR_DIR = path.join(userData, 'var');
    env.AIR_CONFIG_PATH = path.join(userData, 'config.json');
    fs.mkdirSync(env.AIR_VAR_DIR, { recursive: true });
  } else if (!process.env.ELECTRON_RENDERER_URL) {
    env.AEROAGENT_WEB_DIST = path.join(rootDir, 'frontend', 'dist');
  }

  log(`启动后端：${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend = child;
  backendError = undefined;
  child.stdout.on('data', (data) => backendLog.write(data));
  child.stderr.on('data', (data) => backendLog.write(data));
  child.once('error', (error) => {
    backendError = error;
    log(`后端启动失败：${error.message}`);
  });
  child.once('exit', (code, signal) => {
    log(`后端退出：code=${code} signal=${signal}`);
    if (!stopping) {
      backendError = new Error(`后端意外退出（code=${code}, signal=${signal}）`);
      showError(backendError).catch((error) => log(`错误页加载失败：${error.message}`));
    }
  });
}

function requestStatus(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 2000 }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once('timeout', () => request.destroy(new Error('健康检查请求超时')));
    request.once('error', reject);
  });
}

async function waitForHealth(port) {
  const url = `http://127.0.0.1:${port}/api/v1/health`;
  const deadline = Date.now() + healthTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (backendError) {
      throw backendError;
    }
    try {
      const status = await requestStatus(url);
      if (status === 200) {
        log(`健康检查通过：${url}`);
        return;
      }
      lastError = new Error(`健康检查返回 HTTP ${status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`等待后端健康检查超时（${healthTimeoutMs / 1000}s）：${lastError?.message || '无响应'}`);
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => child.once('close', () => resolve(true)));
}

function signalBackend(child, signal, force = false) {
  if (!child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    const args = ['/pid', String(child.pid), '/T'];
    if (force) {
      args.push('/F');
    }
    const killer = spawn('taskkill', args, { stdio: 'ignore' });
    killer.once('error', (error) => log(`进程树清理失败：${error.message}`));
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      try {
        child.kill(signal);
      } catch (fallbackError) {
        log(`后端信号发送失败：${fallbackError.message}`);
      }
    }
  }
}

// 退出清理只执行一次：先优雅终止，超时再强杀，防止残留进程占用数据库。
async function stopBackend() {
  if (cleanupPromise) {
    return cleanupPromise;
  }
  cleanupPromise = (async () => {
    stopping = true;
    const child = backend;
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = waitForClose(child);
      log('正在终止后端进程树（SIGTERM）');
      signalBackend(child, 'SIGTERM');
      const exited = await Promise.race([closed, delay(5000).then(() => false)]);
      if (!exited && child.exitCode === null && child.signalCode === null) {
        log('后端未在 5 秒内退出，强制清理进程树');
        signalBackend(child, 'SIGKILL', true);
        await Promise.race([closed, delay(2000)]);
      }
    }
    backend = undefined;
    if (backendLog) {
      backendLog.end();
    }
  })();
  return cleanupPromise;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

async function showError(error) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const logPath = path.join(app.getPath('logs'), 'backend.log');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AeroAgent 启动失败</title>
    <body style="font-family:-apple-system,sans-serif;max-width:760px;margin:64px auto;padding:0 24px;color:#172033">
    <h1>AeroAgent 启动失败</h1><p>本地服务未能正常启动，请查看后端日志后重试。</p>
    <pre style="white-space:pre-wrap;background:#f3f4f6;padding:16px;border-radius:8px">${escapeHtml(error?.message || error)}</pre>
    <p>日志：${escapeHtml(logPath)}</p></body></html>`;
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.once('ready-to-show', () => window.show());
  return window;
}

// 主进程先初始化日志和窗口，再启动后端、等待健康并加载页面。
async function start() {
  const logsDir = app.getPath('logs');
  fs.mkdirSync(logsDir, { recursive: true });
  backendLog = fs.createWriteStream(path.join(logsDir, 'backend.log'), { flags: 'a' });
  ipcMain.handle('app:get-version', () => app.getVersion());
  mainWindow = createWindow();
  await mainWindow.loadURL('data:text/html;charset=utf-8,<html lang="zh-CN"><meta charset="utf-8"><body style="font-family:-apple-system;margin:64px">正在启动 AeroAgent 本地服务…</body></html>');

  try {
    const port = await getBackendPort();
    startBackend(port);
    await waitForHealth(port);
    const rendererUrl = process.env.ELECTRON_RENDERER_URL || `http://127.0.0.1:${port}/`;
    log(`加载页面：${rendererUrl}`);
    await mainWindow.loadURL(rendererUrl);
  } catch (error) {
    log(`启动失败：${error.message}`);
    await stopBackend();
    await showError(error);
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });
  app.whenReady().then(start).catch(async (error) => {
    log(`主进程异常：${error.stack || error}`);
    await stopBackend();
    await showError(error);
  });
}

// 首次退出先拦截并等待后端清理，避免窗口关闭后留下孤儿进程。
app.on('before-quit', (event) => {
  if (backend && !stopping) {
    event.preventDefault();
    stopBackend().finally(() => app.quit());
  }
});
app.on('window-all-closed', () => app.quit());
process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
