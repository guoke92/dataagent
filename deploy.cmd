@echo off
setlocal
rem Linux / macOS / Git Bash: deploy.sh. This wrapper prefers Git Bash, then PowerShell.
set "GIT_BASH=%ProgramFiles%\Git\bin\bash.exe"
if exist "%GIT_BASH%" goto run_bash
set "GIT_BASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if exist "%GIT_BASH%" goto run_bash
set "GIT_BASH=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
if exist "%GIT_BASH%" goto run_bash

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
exit /b %ERRORLEVEL%

:run_bash
"%GIT_BASH%" "%~dp0deploy.sh" %*
exit /b %ERRORLEVEL%
