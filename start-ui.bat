@echo off
REM ============================================================
REM  Career-Ops UI launcher. DOUBLE-CLICK THIS FILE to run it.
REM  Opens http://localhost:4317 in your browser.
REM  Leave this black window OPEN while you use the dashboard.
REM  Close the window (or press Ctrl+C) to stop the app.
REM ============================================================
cd /d "%~dp0"
title Career-Ops UI  (keep this window open)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js is not installed or not on your PATH.
  echo Install it from https://nodejs.org  then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo Starting Career-Ops UI...
echo Opening http://localhost:4317 in your browser.
echo.
echo   KEEP THIS WINDOW OPEN while you use the dashboard.
echo   Close it to stop the app.
echo.
start "" http://localhost:4317

node server.mjs

REM If node exits (crash or port in use), stop here so you can read the error.
echo.
echo [The server stopped. Read any message above.]
pause
