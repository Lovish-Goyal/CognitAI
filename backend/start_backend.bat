@echo off
REM CognitAI FastAPI Backend Launcher
echo ========================================================
echo Starting CognitAI FastAPI Backend Server on Port 8000...
echo ========================================================
cd /d "%~dp0"
if exist .venv\Scripts\python.exe (
    echo Using backend virtual environment (.venv)...
    .venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
) else (
    echo [ERROR] Virtual environment (.venv) not found.
    echo Python 3.12 with facenet-pytorch in .venv is required to run the server.
    pause
)
