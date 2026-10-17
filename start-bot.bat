@echo off
cd /d "C:\_SORGENTI\TeleBot"

echo [%date% %time%] Avvio script start-bot... >> bot.log

:: Termina eventuali istanze precedenti di node index.js per questo progetto
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -match 'index\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo [%date% %time%] In attesa che Docker sia pronto... >> bot.log
:wait_docker
docker info >nul 2>&1
if %errorlevel% neq 0 (
    timeout /t 5 /nobreak >nul
    goto wait_docker
)

echo [%date% %time%] Docker attivo! Esecuzione di make dev... >> bot.log
make dev >> bot.log 2>&1
