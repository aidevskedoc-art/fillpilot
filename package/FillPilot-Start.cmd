@echo off
rem Starts FillPilot from this folder. Nothing is installed; no administrator rights are needed.
title FillPilot - keep this window open
cd /d "%~dp0"
if not exist "runtime\node\node.exe" (
  echo.
  echo   This folder is incomplete: runtime\node\node.exe is missing.
  echo   Unzip the whole FillPilot folder first, then run this file from inside it.
  echo.
  pause
  exit /b 1
)
"runtime\node\node.exe" "app\launcher.js" start
echo.
pause
