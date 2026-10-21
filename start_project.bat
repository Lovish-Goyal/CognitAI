@echo off
title CognitAI System Launcher
echo ========================================================
echo       Starting CognitAI Facial Attendance System         
echo ========================================================

REM 1. Start FastAPI Backend in a separate window
echo Starting Backend on http://127.0.0.1:8000 ...
start "CognitAI Backend (FastAPI)" cmd /k "cd /d %~dp0backend && .venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000"

REM 2. Wait 2 seconds for backend initialization
timeout /t 2 /nobreak >nul

REM 3. Start Next.js Frontend in a separate window
echo Starting Frontend on http://localhost:3000 ...
start "CognitAI Frontend (Next.js)" cmd /k "cd /d %~dp0frontend && npm run dev"

REM 4. Open browser
timeout /t 3 /nobreak >nul
echo Opening Web Application in Browser...
start http://localhost:3000

echo ========================================================
echo CognitAI is running!
echo Backend:  http://127.0.0.1:8000
echo Frontend: http://localhost:3000
echo ========================================================
