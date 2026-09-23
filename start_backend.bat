@echo off
REM CognitAI FastAPI Backend Launcher (From Root)
echo ========================================================
echo Starting CognitAI FastAPI Backend Server on Port 8000...
echo ========================================================
cd /d "%~dp0backend"
if exist .venv\Scripts\python.exe (
    echo Using backend virtual environment (.venv)...
    .venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
) else (
    echo [ERROR] Virtual environment (.venv) not found in backend directory.
    echo Python 3.12 with facenet-pytorch in backend\.venv is required.
    pause
)
