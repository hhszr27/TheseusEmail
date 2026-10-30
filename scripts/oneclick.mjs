#!/usr/bin/env node
/**
 * MailForge 一键运行 / 测试入口。
 *
 * 用法：
 *   node scripts/oneclick.mjs            启动应用（自动检测本机是否可用安全沙箱）
 *   node scripts/oneclick.mjs strict     强制使用交付配置（sandbox:true）启动
 *   node scripts/oneclick.mjs compat     直接以本机兼容模式启动（--no-sandbox --disable-gpu）
 *   node scripts/oneclick.mjs seed       写入两封演示邮件（含安全样本）
 *   node scripts/oneclick.mjs test       typecheck + 单元/集成测试 + 生产构建
 *   node scripts/oneclick.mjs build      仅构建
 *
 * 说明：主进程/渲染进程的代码安全配置不会被修改；兼容模式只是启动参数。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const NODE = process.execPath;
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', IS_WIN ? 'electron.exe' : 'electron');
const MIRROR = 'https://npmmirror.com/mirrors/electron/';

const color = (code, text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const cyan = (text) => color('36', text);
const green = (text) => color('32', text);
const yellow = (text) => color('33', text);
const red = (text) => color('31', text);
const dim = (text) => color('90', text);

function banner() {
  console.log('');
  console.log(cyan('  MailForge · Phase 1'));
  console.log(dim(`  项目目录  ${ROOT}`));
  console.log('');
}

function step(text) {
  console.log(`${cyan('›')} ${text}`);
}

function ok(text) {
  console.log(`${green('✓')} ${text}`);
}

function warn(text) {
  console.log(`${yellow('!')} ${text}`);
}

function fail(text) {
  console.log(`${red('✗')} ${text}`);
}

function runNode(scriptPath, args = [], options = {}) {
  return spawnSync(NODE, [scriptPath, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: cleanEnv(options.env),
    ...options,
  });
}

function runElectron(scriptPath, args = []) {
  return spawnSync(ELECTRON, [scriptPath, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: cleanEnv(),
  });
}

function cleanEnv(extra) {
  const env = { ...process.env, ...(extra ?? {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function npmExecutable() {
  const beside = path.join(path.dirname(NODE), IS_WIN ? 'npm.cmd' : 'npm');
  return fs.existsSync(beside) ? beside : 'npm';
}

function runNpm(args, extraEnv) {
  return spawnSync(npmExecutable(), args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WIN,
    env: cleanEnv(extraEnv),
  });
}

function ensureDependencies() {
  const electronPackage = path.join(ROOT, 'node_modules', 'electron', 'package.json');

  if (!fs.existsSync(electronPackage)) {
    step('未检测到依赖，正在安装（首次可能需要几分钟）…');
    const result = runNpm(['install'], { ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || MIRROR });
    if (result.status !== 0) {
      fail('依赖安装失败，请检查网络后重试。');
      return false;
    }
  }

  if (!fs.existsSync(ELECTRON)) {
    step('未检测到 Electron 二进制，正在通过镜像下载…');
    const installer = path.join(ROOT, 'node_modules', 'electron', 'install.js');
    const result = runNode(installer, [], {
      env: { ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || MIRROR },
    });
    if (result.status !== 0 || !fs.existsSync(ELECTRON)) {
      fail('Electron 下载失败。可手动设置 ELECTRON_MIRROR 后重试。');
      return false;
    }
  }

  return true;
}

function buildApp() {
  step('构建主进程 / preload / 渲染进程…');
  const result = runNode(path.join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), [
    'build',
  ]);
  if (result.status !== 0) {
    fail('构建失败，请查看上方错误。');
    return false;
  }
  ok('构建完成');
  return true;
}

function typecheck() {
  step('类型检查（主进程 + 渲染进程）…');
  const bin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  for (const project of ['tsconfig.node.json', 'tsconfig.web.json']) {
    const result = spawnSync(NODE, [bin, '--noEmit', '-p', project], {
      cwd: ROOT,
      stdio: 'inherit',
      env: cleanEnv(),
    });
    if (result.status !== 0) {
      fail(`类型检查失败：${project}`);
      return false;
    }
  }
  ok('类型检查通过');
  return true;
}

function runTests() {
  step('运行单元与集成测试…');
  const vitest = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const result = spawnSync(NODE, [vitest, 'run'], { cwd: ROOT, stdio: 'inherit', env: cleanEnv() });
  if (result.status !== 0) {
    fail('测试失败');
    return false;
  }
  ok('测试全部通过');
  return true;
}

function userDataDir() {
  if (IS_WIN) {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'MailForge');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'MailForge');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'MailForge');
}

function todayLogPath() {
  const now = new Date();
  const y = now.getFullYear();
  const m = `${now.getMonth() + 1}`.padStart(2, '0');
  const d = `${now.getDate()}`.padStart(2, '0');
  return path.join(userDataDir(), 'logs', `app-${y}-${m}-${d}.log`);
}

function logSize() {
  try {
    return fs.statSync(todayLogPath()).size;
  } catch {
    return 0;
  }
}

function readSince(offset) {
  const file = todayLogPath();
  try {
    const stat = fs.statSync(file);
    const start = stat.size < offset ? 0 : offset;
    const length = stat.size - start;
    if (length <= 0) return '';
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    fs.closeSync(fd);
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

function launch(extraArgs) {
  const child = spawn(ELECTRON, ['.', ...extraArgs], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: cleanEnv(),
  });
  child.unref();
  return child.pid;
}

function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
}

function isAlive(pid) {
  if (!pid) return false;
  if (IS_WIN) {
    // Windows 上 process.kill(pid, 0) 对 detached 进程可能抛 EPERM，
    // 会误判为"已退出"，进而被单实例锁挡掉后续启动。改用 tasklist 判定。
    const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' });
    return String(result.stdout || '').includes(String(pid));
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 等待进程真正退出，避免单实例锁把紧接着启动的兼容实例挡掉。 */
async function waitForExit(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(200);
  }
  return !isAlive(pid);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reportStarted(mode) {
  console.log('');
  ok(`应用已启动（${mode}）`);
  console.log(dim(`  日志      ${todayLogPath()}`));
  console.log(dim(`  本地数据  ${userDataDir()}`));
  console.log(dim('  本窗口可以直接关闭。'));
}

async function startApp(mode) {
  if (!ensureDependencies()) return false;
  if (!buildApp()) return false;

  if (mode === 'compat') {
    launch(['--no-sandbox', '--disable-gpu']);
    reportStarted('本机兼容模式：已关闭 Chromium 沙箱与 GPU');
    return true;
  }

  if (mode === 'strict') {
    launch([]);
    reportStarted('交付配置：sandbox=true');
    return true;
  }

  // 自动探测：先用交付配置启动，若本机渲染/GPU 进程崩溃则自动切换兼容模式
  const offset = logSize();
  const pid = launch([]);
  step('已按交付配置启动，正在探测本机图形环境…');
  await sleep(8000);

  const text = readSince(offset);
  const crashed = /渲染进程崩溃|GPU 进程崩溃/.test(text);

  if (!crashed) {
    reportStarted('交付配置：sandbox=true');
    return true;
  }

  warn('本机沙箱/GPU 不可用（检测到进程崩溃），正在切换兼容模式…');
  killTree(pid);
  await waitForExit(pid);
  await sleep(800);

  const fallbackPid = launch(['--no-sandbox', '--disable-gpu']);
  await sleep(1200);
  if (!isAlive(fallbackPid)) {
    fail('兼容模式启动失败。请手动运行：node_modules\\electron\\dist\\electron.exe . --no-sandbox --disable-gpu');
    return false;
  }

  reportStarted('本机兼容模式：已关闭 Chromium 沙箱与 GPU');
  console.log(
    dim('  注意：兼容模式仅用于本地调试；交付配置仍为 sandbox=true，未修改任何代码。'),
  );
  return true;
}

function seedDemo() {
  if (!ensureDependencies()) return false;
  if (!fs.existsSync(path.join(userDataDir(), 'mailforge.db'))) {
    warn('本地数据库还不存在，请先启动一次应用完成初始化。');
    return false;
  }

  step('写入演示邮件…');
  const result = runElectron(path.join(ROOT, 'scripts', 'seed-demo.js'));
  if (result.status !== 0) {
    fail('写入失败。若应用正在运行，请先关闭应用再执行 seed。');
    return false;
  }

  // 先写附件再写邮件会因关系级联被清掉，因此顺序固定为邮件 → 附件
  step('写入演示附件…');
  const attachmentSeed = path.join(ROOT, 'scripts', 'seed-attachments.js');
  if (fs.existsSync(attachmentSeed)) {
    const attachResult = runElectron(attachmentSeed);
    if (attachResult.status !== 0) {
      warn('附件样本写入失败，邮件已写入；可稍后单独运行 scripts/seed-attachments.js。');
    }
  }

  ok('演示邮件与附件已写入，启动应用后即可在收件箱查看。');
  return true;
}

function printHelp() {
  console.log('用法：node scripts/oneclick.mjs [命令]');
  console.log('');
  console.log('  start   启动应用（默认；自动探测是否需要兼容模式）');
  console.log('  strict  强制使用交付配置启动（sandbox:true）');
  console.log('  compat  直接以本机兼容模式启动（--no-sandbox --disable-gpu）');
  console.log('  seed    写入两封演示邮件');
  console.log('  test    类型检查 + 测试 + 构建');
  console.log('  build   仅构建');
  console.log('  help    显示本帮助');
}

async function main() {
  const mode = (process.argv[2] || 'start').toLowerCase();
  banner();

  switch (mode) {
    case 'start':
      return (await startApp('auto')) ? 0 : 1;
    case 'strict':
      return (await startApp('strict')) ? 0 : 1;
    case 'compat':
      return (await startApp('compat')) ? 0 : 1;
    case 'seed':
      return seedDemo() ? 0 : 1;
    case 'build':
      return buildApp() ? 0 : 1;
    case 'test': {
      if (!ensureDependencies()) return 1;
      const passed = typecheck() && runTests() && buildApp();
      if (passed) {
        console.log('');
        ok('全部检查通过，可以交付测试。');
      }
      return passed ? 0 : 1;
    }
    case 'help':
    case '-h':
    case '--help':
      printHelp();
      return 0;
    default:
      fail(`未知命令：${mode}`);
      printHelp();
      return 2;
  }
}

main().then((code) => {
  process.exitCode = code;
});
