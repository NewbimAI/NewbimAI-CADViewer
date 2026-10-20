@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   CADViewer - Local CAD Viewer
echo ============================================

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found in PATH. Please install Node.js first.
  pause
  exit /b 1
)

if not exist "server\node_modules" (
  echo [1/3] Installing server dependencies...
  pushd server && call npm install --no-fund --no-audit && popd
  if errorlevel 1 goto :fail
) else (
  echo [1/3] Server dependencies OK.
)

if not exist "web\node_modules" (
  echo [2/3] Installing web dependencies...
  pushd web && call npm install --no-fund --no-audit && popd
  if errorlevel 1 goto :fail
) else (
  echo [2/3] Web dependencies OK.
)

if not exist "web\dist\index.html" (
  echo [3/3] Building web frontend...
  pushd web && call npm run build && popd
  if errorlevel 1 goto :fail
) else (
  echo [3/3] Web frontend build OK.
)

echo.
echo Starting server at http://127.0.0.1:3717 ...
start "" http://127.0.0.1:3717
pushd server && call node index.js
popd
goto :eof

:fail
echo.
echo [ERROR] Startup failed. Check messages above.
pause
