@echo off
rem Starts the local server and opens Party Mix DJ in Edge (Chrome also works).
cd /d "%~dp0"
start "PartyMixDJ server" /min node server.js
timeout /t 1 /nobreak >nul
start "" msedge "http://localhost:5173"
