' OpenSpoty on the PC: starts the bridge in the background (if it isn't running)
' and opens the app in its own window. /background = bridge only (at login).
Set sh = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName)))
appdata = sh.ExpandEnvironmentStrings("%APPDATA%")

Function BridgeUp()
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP")
  http.setTimeouts 1000, 1000, 1000, 1000
  http.open "GET", "http://127.0.0.1:8777/api/ping", False
  http.send
  BridgeUp = (Err.Number = 0 And http.status = 200)
End Function

If Not BridgeUp() Then
  sh.Environment("PROCESS")("PYTHONIOENCODING") = "utf-8"
  cmd = "cmd /c """"" & appdata & "\StemKit\venv\Scripts\python.exe"" -u """ & root & "\bridge\stemkit_bridge.py"" > """ & appdata & "\StemKitMobile\bridge.log"" 2>&1"""
  sh.Run cmd, 0, False
  For i = 1 To 40
    WScript.Sleep 500
    If BridgeUp() Then Exit For
  Next
End If

If WScript.Arguments.Count = 0 Then
  sh.Run """C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"" --app=http://127.0.0.1:8777/ --window-size=560,980", 1, False
End If
