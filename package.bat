@echo off
setlocal

cd /d "%~dp0"

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Windows PowerShell was not found.
  exit /b 1
)

echo [INFO] Creating the Chrome extension package...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\package.ps1"
set "PACKAGE_EXIT_CODE=%ERRORLEVEL%"

if not "%PACKAGE_EXIT_CODE%"=="0" (
  echo [ERROR] Packaging failed with exit code %PACKAGE_EXIT_CODE%.
  exit /b %PACKAGE_EXIT_CODE%
)

echo [OK] Package creation completed.
echo [OK] Output: %~dp0release\netflix-dual-subtitles-v0.1.0.zip
exit /b 0
