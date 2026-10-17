Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\_SORGENTI\TeleBot"
WshShell.Run chr(34) & "C:\_SORGENTI\TeleBot\start-bot.bat" & chr(34), 0, False
Set WshShell = Nothing
