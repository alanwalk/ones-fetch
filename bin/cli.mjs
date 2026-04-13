#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getServiceStatus, getServiceStatePath, startService, stopService } from '../src/service-manager.mjs';

const command = process.argv[2] || '';
const flags = new Set(process.argv.slice(3));
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const serverEntryPath = join(projectRoot, 'src', 'server.mjs');

function printHelp() {
  console.log('ONES Fetch\n');
  console.log('用法：');
  console.log('  ones-fetch           前台启动工具');
  console.log('  ones-fetch start     后台启动本地服务');
  console.log('  ones-fetch stop      停止后台服务');
  console.log('  ones-fetch status    查看后台服务状态');
  console.log('  ones-fetch restart   重启后台服务');
  console.log('  ones-fetch install   安装到本地并创建桌面快捷方式');
}

function formatStartedAt(startedAt) {
  if (!startedAt) return 'unknown';
  return startedAt;
}

async function handleStart() {
  const result = await startService({
    serverEntryPath,
    projectRoot,
    open: !flags.has('--no-open'),
  });

  if (result.status === 'started') {
    console.log(`服务已启动: ${result.url} (pid: ${result.pid})`);
    console.log(`状态文件: ${getServiceStatePath()}`);
    return;
  }

  if (result.status === 'already_running') {
    console.log(`服务已在运行: ${result.url} (pid: ${result.pid})`);
    return;
  }

  console.error(`启动失败: ${result.reason ?? 'unknown error'}`);
  process.exit(1);
}

async function handleStop() {
  const result = await stopService();

  if (result.status === 'stopped') {
    console.log(`服务已停止: pid ${result.pid}`);
    return;
  }

  if (result.status === 'not_running') {
    console.log('服务当前未运行');
    return;
  }

  if (result.status === 'unmanaged_running') {
    console.error(`检测到未受管实例在运行: ${result.url} (pid: ${result.pid})`);
    console.error('当前 stop 只会停止由 ones-fetch start 启动并记录了状态文件的实例。');
    process.exit(1);
  }

  console.error(`停止超时: pid ${result.pid}`);
  process.exit(1);
}

async function handleStatus() {
  const result = await getServiceStatus();

  if (result.state === 'running') {
    console.log(`状态: running${result.managed ? '' : ' (unmanaged)'}`);
    console.log(`PID: ${result.pid}`);
    console.log(`URL: ${result.url}`);
    console.log(`Started At: ${formatStartedAt(result.startedAt)}`);
    return;
  }

  if (result.state === 'unhealthy') {
    console.log('状态: unhealthy');
    console.log(`PID: ${result.pid}`);
    console.log(`URL: ${result.url}`);
    console.log(`Started At: ${formatStartedAt(result.startedAt)}`);
    process.exit(1);
  }

  console.log('状态: stopped');
  process.exit(1);
}

async function handleRestart() {
  const stopped = await stopService();
  if (stopped.status === 'unmanaged_running') {
    console.error(`检测到未受管实例在运行: ${stopped.url} (pid: ${stopped.pid})`);
    process.exit(1);
  }
  if (stopped.status === 'stop_timeout') {
    console.error(`停止超时: pid ${stopped.pid}`);
    process.exit(1);
  }
  await handleStart();
}

async function main() {
  if (command === 'install') {
    const { runInstallFlow } = await import('./install.mjs');
    await runInstallFlow();
    return;
  }

  if (command === 'start') {
    await handleStart();
    return;
  }

  if (command === 'stop') {
    await handleStop();
    return;
  }

  if (command === 'status') {
    await handleStatus();
    return;
  }

  if (command === 'restart') {
    await handleRestart();
    return;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }

  if (command) {
    console.error(`不支持的命令: ${command}`);
    printHelp();
    process.exit(1);
  }

  await import('../src/server.mjs');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
