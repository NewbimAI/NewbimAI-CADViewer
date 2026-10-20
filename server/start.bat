@echo off
rem Server-only launcher: start.bat also opens a browser tab, which is noisy when
rem the server is being restarted by tooling. Keep this file ASCII-only.
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node index.js
