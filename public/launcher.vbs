Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 获取项目根目录
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDir)

' 启动服务器（后台运行）
WshShell.Run "cmd /c cd /d """ & projectRoot & """ && node src/server.mjs", 0, False

' 等待服务器启动
WScript.Sleep 1500

' 打开浏览器
WshShell.Run "http://localhost:3000", 1
