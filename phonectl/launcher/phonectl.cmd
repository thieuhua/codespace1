@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0phonectl.ps1" %*
exit /b %errorlevel%
