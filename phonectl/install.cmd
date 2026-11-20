@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "phonectl_exit=%errorlevel%"
echo.
pause
exit /b %phonectl_exit%
