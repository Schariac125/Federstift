@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Federstift - AI Novel Studio

rem ---- 检查 Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo [Federstift] Node.js not found. Please install Node.js 18+ from https://nodejs.org/
  echo [Federstift] Then double-click run.bat again.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node --version') do set NODE_VER=%%v
echo [Federstift] Node.js detected: %NODE_VER%

rem ---- 依赖安装（仅首次） ----
if not exist "node_modules\typescript" (
  echo [Federstift] First run: installing TypeScript compiler ^(one-time, needs network^)...
  call npm install --no-audit --no-fund >nul 2>nul
  if errorlevel 1 (
    echo [Federstift] npm install failed. Please check your network and try again.
    pause
    exit /b 1
  )
)

rem ---- 构建（秒级，确保使用最新源码） ----
call npx tsc
if errorlevel 1 (
  echo [Federstift] Build failed. Please report the error above.
  pause
  exit /b 1
)

rem ---- 默认进入图形界面（GUI）；带参数则执行命令行入口 ----
if "%~1"=="" (
  echo [Federstift] Launching GUI... Close this window or press Ctrl+C to stop.
  node "dist\cli\index.js" gui
) else (
  node "dist\cli\index.js" %*
)
pause
