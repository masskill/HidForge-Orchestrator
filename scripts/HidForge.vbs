' HidForge Orchestrator: start without a terminal window and open the UI in the default browser.
' A second start only opens the browser: the server detects an already running instance.
' Server output goes to %LOCALAPPDATA%\HidForge\hidforge.log. Stop it from the UI: Settings -> Stop server.
Option Explicit
Dim fso, sh, root, logDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
If sh.Run("cmd /c where node", 0, True) <> 0 Then
  ' Ukrainian text, built from ChrW: "Node.js 24+ not found. Install it from https://nodejs.org and start HidForge again."
  MsgBox "Node.js 24+ " & ChrW(1085) & ChrW(1077) & " " & ChrW(1079) & ChrW(1085) & ChrW(1072) & ChrW(1081) & ChrW(1076) & ChrW(1077) & ChrW(1085) & ChrW(1086) & ". " & ChrW(1042) & ChrW(1089) & ChrW(1090) & ChrW(1072) & ChrW(1085) & ChrW(1086) & ChrW(1074) & ChrW(1110) & ChrW(1090) & ChrW(1100) & " " & ChrW(1081) & ChrW(1086) & ChrW(1075) & ChrW(1086) & " " & ChrW(1079) & " https://nodejs.org " & ChrW(1110) & " " & ChrW(1079) & ChrW(1072) & ChrW(1087) & ChrW(1091) & ChrW(1089) & ChrW(1090) & ChrW(1110) & ChrW(1090) & ChrW(1100) & " HidForge " & ChrW(1079) & ChrW(1085) & ChrW(1086) & ChrW(1074) & ChrW(1091) & ".", vbExclamation, "HidForge Orchestrator"
  WScript.Quit 1
End If
logDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\HidForge"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
sh.CurrentDirectory = root
sh.Run "cmd /c node src\main.ts --open >> """ & logDir & "\hidforge.log"" 2>&1", 0, False
