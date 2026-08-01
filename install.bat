@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Federstift - Install & Build

where node >nul 2>nul
if errorlevel 1 (
  echo [Federstift] Node.js not found. Please install Node.js 18+ from https://nodejs.org/
  pause
  exit /b 1
)

echo [Federstift] Installing dependencies (one-time)...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo [Federstift] npm install failed. Please check your network and try again.
  pause
  exit /b 1
)

echo [Federstift] Building...
call npx tsc
if errorlevel 1 (
  echo [Federstift] Build failed.
  pause
  exit /b 1
)

echo [Federstift] Done. You can now double-click run.bat to start.
pause
