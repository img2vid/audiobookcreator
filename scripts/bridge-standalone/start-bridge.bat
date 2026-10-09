@echo off
cd /d "%~dp0"
title OS Speech Bridge - KEEP THIS WINDOW OPEN
echo ============================================================
echo   OS Speech Bridge  -  http://127.0.0.1:8477
echo ============================================================
echo.
echo KEEP THIS WINDOW OPEN - closing it stops the bridge.
echo In the app: leave the bridge URL field EMPTY and press Retry.
echo.
echo If "node is not recognized" appears below, install the LTS
echo version from https://nodejs.org and run this file again.
echo.
node os-tts-server.mjs
echo.
echo The bridge stopped. Screenshot any error above and send it.
pause
