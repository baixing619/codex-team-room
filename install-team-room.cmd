@echo off
setlocal
title Codex Team Room Installer
set "TEAM_ROOM_NO_PAUSE=0"
for %%A in (%*) do if /I "%%~A"=="--no-pause" set "TEAM_ROOM_NO_PAUSE=1"
set "TEAM_ROOM_NODE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined TEAM_ROOM_NODE set "TEAM_ROOM_NODE=%%N"
if not defined TEAM_ROOM_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "TEAM_ROOM_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined TEAM_ROOM_NODE (
  where winget.exe >nul 2>nul
  if errorlevel 1 (
    echo Node.js LTS is required and Windows App Installer is unavailable.
    set "TEAM_ROOM_EXIT=1"
    goto finish
  )
  echo Installing Node.js LTS...
  winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements --silent
  if exist "%ProgramFiles%\nodejs\node.exe" set "TEAM_ROOM_NODE=%ProgramFiles%\nodejs\node.exe"
)
if not defined TEAM_ROOM_NODE (
  echo Node.js was installed but is not available yet. Sign out of Windows, sign in, and run this file again.
  set "TEAM_ROOM_EXIT=1"
  goto finish
)
"%TEAM_ROOM_NODE%" "%~dp0scripts\install-windows.mjs" %*
set "TEAM_ROOM_EXIT=%ERRORLEVEL%"
:finish
if "%TEAM_ROOM_NO_PAUSE%"=="0" pause
exit /b %TEAM_ROOM_EXIT%
