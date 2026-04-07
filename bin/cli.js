#!/usr/bin/env node

const command = process.argv[2] || '';

function printHelp() {
  console.log('ONES Fetch\n');
  console.log('用法：');
  console.log('  ones-fetch           一次性启动工具');
  console.log('  ones-fetch install   安装到本地并创建桌面快捷方式');
}

async function main() {
  if (command === 'install') {
    const { runInstallFlow } = await import('./install.mjs');
    await runInstallFlow();
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
