@echo off
title Berk Engine - Claws of Berk
cd /d "%~dp0"
echo Starting Berk Engine on http://localhost:8902 ...
start "" http://localhost:8902
python -m http.server 8902
if errorlevel 1 (
  echo Python not found on PATH. Install Python 3, or run any static file server in this folder.
  pause
)
