@echo off
cd /d "%~dp0\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\petpooja-static-egress.ps1" -Action Stop
if errorlevel 1 pause
