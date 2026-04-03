Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 获取脚本所在目录
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' 检查 Node.js 是否安装
On Error Resume Next
WshShell.Run "node --version", 0, True
If Err.Number <> 0 Then
    MsgBox "未检测到 Node.js，请先安装 Node.js 18 或更高版本。" & vbCrLf & vbCrLf & "下载地址：https://nodejs.org/", vbCritical, "ONES 采集工具"
    WScript.Quit
End If
On Error Goto 0

' 检查是否已安装依赖
If Not fso.FolderExists(scriptDir & "\node_modules") Then
    result = MsgBox("首次运行需要安装依赖（约 30MB），是否继续？", vbYesNo + vbQuestion, "ONES 采集工具")
    If result = vbNo Then
        WScript.Quit
    End If

    ' 显示安装窗口
    WshShell.Run "cmd /c cd /d """ & scriptDir & """ && npm install && pause", 1, True
End If

' 启动服务器（后台运行）
WshShell.Run "cmd /c cd /d """ & scriptDir & """ && node src/server.mjs", 0, False

' 等待服务器启动
WScript.Sleep 2000

' 打开浏览器
WshShell.Run "http://localhost:3000", 1
