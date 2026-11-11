@echo off
rem Starts Hivescope and opens it in your browser. Close this window to stop it.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies, first run only...
  call npm install --no-audit --no-fund || goto :error
)
echo Building the page...
call npx vite build --logLevel warn || goto :error
start "" http://127.0.0.1:4317
node --import tsx server/index.ts
goto :eof

:error
echo.
echo Hivescope could not start. See the messages above.
pause
