@echo off
rem Double-click to start the pixel cat (installs dependencies on first run).
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies, one moment...
  call npm install
)
start "" "node_modules\electron\dist\electron.exe" .
