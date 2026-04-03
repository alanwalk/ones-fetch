#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { writeFile, mkdir, cp, access, rm, readFile } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// 固定安装目录（用户主目录下）
const installDir = join(homedir(), '.ones-fetch');

async function ensureInstallDir() {
  try {
    await access(installDir);
    console.log(`检测到现有安装目录: ${installDir}`);

    // 检查版本是否需要更新
    let needsUpdate = false;
    try {
      const installedPkgPath = join(installDir, 'package.json');
      const currentPkgPath = join(projectRoot, 'package.json');

      const installedPkg = JSON.parse(await readFile(installedPkgPath, 'utf8'));
      const currentPkg = JSON.parse(await readFile(currentPkgPath, 'utf8'));

      if (installedPkg.version !== currentPkg.version) {
        console.log(`检测到版本更新: ${installedPkg.version} → ${currentPkg.version}`);
        needsUpdate = true;
      }
    } catch {
      // 如果无法读取版本信息，假设需要更新
      needsUpdate = true;
    }

    if (needsUpdate) {
      console.log('正在清理旧版本文件...');
      // 清理旧的项目文件，但保留 credentials.json 和 node_modules
      const dirsToClean = ['src', 'public', 'bin'];
      const filesToClean = ['package.json', 'package-lock.json'];

      for (const dir of dirsToClean) {
        try {
          await rm(join(installDir, dir), { recursive: true, force: true });
        } catch {}
      }

      for (const file of filesToClean) {
        try {
          await rm(join(installDir, file), { force: true });
        } catch {}
      }

      console.log('✓ 旧版本文件清理完成');
      console.log('正在复制新版本文件...');

      // 复制新版本文件
      await cp(join(projectRoot, 'src'), join(installDir, 'src'), { recursive: true });
      await cp(join(projectRoot, 'public'), join(installDir, 'public'), { recursive: true });
      await cp(join(projectRoot, 'bin'), join(installDir, 'bin'), { recursive: true });
      await cp(join(projectRoot, 'package.json'), join(installDir, 'package.json'));
      await cp(join(projectRoot, 'package-lock.json'), join(installDir, 'package-lock.json')).catch(() => {});
      console.log('✓ 新版本文件复制完成');
    } else {
      console.log('版本已是最新，跳过文件更新');
    }
  } catch {
    // 目录不存在，首次安装
    console.log(`正在复制项目文件到 ${installDir}...`);
    await mkdir(installDir, { recursive: true });

    // 复制必要的文件和目录
    try {
      await cp(join(projectRoot, 'src'), join(installDir, 'src'), { recursive: true });
      await cp(join(projectRoot, 'public'), join(installDir, 'public'), { recursive: true });
      await cp(join(projectRoot, 'bin'), join(installDir, 'bin'), { recursive: true });
      await cp(join(projectRoot, 'package.json'), join(installDir, 'package.json'));
      await cp(join(projectRoot, 'package-lock.json'), join(installDir, 'package-lock.json')).catch(() => {});
      console.log('✓ 项目文件复制完成');
    } catch (err) {
      console.error('✗ 文件复制失败:', err.message);
      throw err;
    }
  }
}

async function createWindowsShortcut() {
  const desktop = join(homedir(), 'Desktop');
  const shortcutPath = join(desktop, 'ONES 采集工具.lnk');
  const iconPath = join(installDir, 'public', 'icon.ico');
  const vbsLauncher = join(installDir, 'public', 'launcher.vbs');

  // 创建 PowerShell 脚本来生成快捷方式
  const psScript = `
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("${shortcutPath.replace(/\\/g, '\\\\')}")
$Shortcut.TargetPath = "wscript.exe"
$Shortcut.Arguments = '"${vbsLauncher.replace(/\\/g, '\\\\')}"'
$Shortcut.WorkingDirectory = "${installDir.replace(/\\/g, '\\\\')}"
$Shortcut.IconLocation = "${iconPath.replace(/\\/g, '\\\\')},0"
$Shortcut.Description = "ONES 任务采集工具"
$Shortcut.Save()
`;

  const tempPs1 = join(installDir, 'temp-create-shortcut.ps1');
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
  // 检测是否是通过 npx 或 postinstall 运行
  const isPostInstall = process.env.npm_lifecycle_event === 'postinstall';

  // 确保安装目录存在
  await ensureInstallDir();

  if (isPostInstall) {
    // postinstall 时只创建快捷方式，不安装依赖
    console.log('ONES Fetch 安装后配置\n');
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
      // 不退出，允许安装继续
    }
    console.log('\n✓ 配置完成！');
    console.log('\n使用方法：');
    console.log('  1. 双击桌面上的 "ONES 采集工具" 图标');
    console.log('  2. 浏览器会自动打开工具页面');
    console.log(`\n项目位置：${installDir}`);
    return;
  }

  // npx 运行时的完整安装流程
  console.log('ONES Fetch 安装程序\n');

  // 安装依赖
  console.log('正在安装依赖...');
  try {
    await execAsync('npm install', { cwd: installDir });
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
  console.log(`\n项目位置：${installDir}`);
}

main().catch(console.error);
