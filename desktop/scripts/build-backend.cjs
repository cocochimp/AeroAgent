const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const desktopDir = path.resolve(__dirname, '..');
const rootDir = path.resolve(desktopDir, '..');
const buildDir = path.join(desktopDir, 'build');
const distDir = path.join(buildDir, 'backend');
const workDir = path.join(buildDir, 'pyinstaller');

fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });

// 将运行资源按 PyInstaller 格式打包进后端目录。
const addData = (source, target) => `${path.join(rootDir, source)}${path.delimiter}${target}`;
const args = [
  'run', '--with', 'pyinstaller', 'pyinstaller',
  '--noconfirm',
  '--clean',
  '--onedir',
  '--name', 'aeroagent-api',
  '--paths', rootDir,
  '--distpath', distDir,
  '--workpath', workDir,
  '--specpath', buildDir,
  '--collect-submodules', 'app',
  '--add-data', addData('demo_data', 'demo_data'),
  '--add-data', addData('migrations', 'migrations'),
  '--add-data', addData('eval', 'eval'),
  path.join(desktopDir, 'backend_entry.py'),
];

console.log('[build-backend] 使用 PyInstaller onedir 构建后端');
// 同步执行并透传失败状态，避免后端未生成时继续打包。
const result = spawnSync('uv', args, { cwd: rootDir, stdio: 'inherit' });
if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
console.log(`[build-backend] 后端已输出到 ${path.join(distDir, 'aeroagent-api')}`);
