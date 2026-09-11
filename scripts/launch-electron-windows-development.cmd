@echo off
setlocal
if not "%~1"=="" (
  echo Usage: TiboTattle-Windows-Development-Launch.cmd
  exit /b 2
)
set "APP=%~dp0win-unpacked\TiboTattle Dev.exe"
set "LAUNCHER=%~dp0TiboTattle-Windows-Development-Launcher.mjs"
set "PROFILE=%LOCALAPPDATA%\TiboTattle\electron-user-test\win32-x64\profile"
if not exist "%APP%" (
  echo The unpacked TiboTattle Dev.exe was not found beside this wrapper.
  exit /b 3
)
if not exist "%LAUNCHER%" (
  echo The bundled Windows development launcher was not found beside this wrapper.
  exit /b 4
)
set "ELECTRON_RUN_AS_NODE=1"
"%APP%" "%LAUNCHER%" --app "%APP%" --profile "%PROFILE%"
set "EXIT_CODE=%ERRORLEVEL%"
set "ELECTRON_RUN_AS_NODE="
exit /b %EXIT_CODE%
