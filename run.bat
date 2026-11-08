@echo off
rem Starts the Aether engine and opens the UI. Double-click to run.
cd /d "%~dp0"
if exist .venv\Scripts\python.exe (
  .venv\Scripts\python.exe -m engine --open
) else (
  python -m engine --open
)
pause
