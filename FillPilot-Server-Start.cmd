@echo off
rem Starts the FillPilot server (backend, port 4100) on this PC, for this PC and the team's PCs.
rem PostgreSQL must be running (its Windows service starts by itself). Closing this window stops the server.
rem If the server is already running, this says so and starts nothing.
title FillPilot server - keep this window open
cd /d "%~dp0backend"
node src\server.js
echo.
pause
