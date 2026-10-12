@echo off
rem Stops FillPilot if it is still running.
title FillPilot - stop
cd /d "%~dp0"
"runtime\node\node.exe" "app\launcher.js" stop
echo.
pause
