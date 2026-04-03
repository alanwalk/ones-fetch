#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { writeFile, mkdir } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

async function createWindowsShortcut() {
  const desktop = join(homedir(), 'Desktop');
  const shortcutPath = join(desktop, 'ONES 采集工具.lnk');
  const iconPath = join(projectRoot, 'public', 'icon.png');
  const vbsLauncher = join(projectRoot, 'public', 'launcher.vbs');

  // 创建 PowerShell 脚本来生成快捷方式
  const psScript = `
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("${shortcutPath.replace(/\\/g, '\\\\')}")
$Shortcut.TargetPath = "wscript.exe"
$Shortcut.Arguments = '"${vbsLauncher.replace(/\\/g, '\\\\')}"'
$Shortcut.WorkingDirectory = "${projectRoot.replace(/\\/g, '\\\\')}"
$Shortcut.IconLocation = "${iconPath.replace(/\\/g, '\\\\')}"
$Shortcut.Description = "ONES 任务采集工具"
$Shortcut.Save()
`;

  const tempPs1 = join(projectRoot, 'temp-create-shortcut.ps1');
  await writeFile(tempPs1, psScript, 'utf8');

  try {
    await execAsync(`powershell -ExecutionPolicy Bypass -File "${tempPs1}"`);
    console.log(`✓ 桌面快捷方式已创建: ${shortcutPath}`);
  } finally {
    // 清理临时文件
    try {
      await execAsync(`del "${tempPs1}"`);
    } catch {}
  }
}

async function createMacShortcut() {
  const desktop = join(homedir(), 'Desktop');
  const appPath = join(desktop, 'ONES 采集工具.command');

  const scriptContent = `#!/bin/bash
cd "${projectRoot}"
node src/server.mjs &
sleep 2
open http://localhost:3000
`;

  await writeFile(appPath, scriptContent, 'utf8');
  await execAsync(`chmod +x "${appPath}"`);
  console.log(`✓ 桌面快捷方式已创建: ${appPath}`);
}

async function createLinuxShortcut() {
  const desktop = join(homedir(), 'Desktop');
  const desktopFile = join(desktop, 'ones-fetch.desktop');

  const content = `[Desktop Entry]
Version=1.0
Type=Application
Name=ONES 采集工具
Exec=bash -c "cd ${projectRoot} && node src/server.mjs & sleep 2 && xdg-open http://localhost:3000"
Icon=utilities-terminal
Terminal=false
Categories=Utility;
`;

  await writeFile(desktopFile, content, 'utf8');
  await execAsync(`chmod +x "${desktopFile}"`);
  console.log(`✓ 桌面快捷方式已创建: ${desktopFile}`);
}

async function main() {
  console.log('ONES Fetch 安装程序\n');

  // 安装依赖
  console.log('正在安装依赖...');
  try {
    await execAsync('npm install', { cwd: projectRoot });
    console.log('✓ 依赖安装完成\n');
  } catch (err) {
    console.error('✗ 依赖安装失败:', err.message);
    process.exit(1);
  }

  // 创建桌面快捷方式
  console.log('正在创建桌面快捷方式...');
  try {
    const os = platform();
    if (os === 'win32') {
      await createWindowsShortcut();
    } else if (os === 'darwin') {
      await createMacShortcut();
    } else {
      await createLinuxShortcut();
    }
  } catch (err) {
    console.error('✗ 快捷方式创建失败:', err.message);
    process.exit(1);
  }

  console.log('\n✓ 安装完成！');
  console.log('\n使用方法：');
  console.log('  1. 双击桌面上的 "ONES 采集工具" 图标');
  console.log('  2. 浏览器会自动打开工具页面');
  console.log('\n或者在命令行运行：');
  console.log(`  cd ${projectRoot}`);
  console.log('  npm start');
}

main().catch(console.error);
