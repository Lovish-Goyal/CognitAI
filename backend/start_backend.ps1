# CognitAI FastAPI Backend Launcher (PowerShell)
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "Starting CognitAI FastAPI Backend Server on Port 8000..." -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$venvPython = ".\.venv\Scripts\python.exe"
if (Test-Path $venvPython) {
    Write-Host "Using backend virtual environment (.venv)..." -ForegroundColor Green
    & $venvPython -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
} else {
    Write-Host "[ERROR] Virtual environment (.venv) not found." -ForegroundColor Red
    Write-Host "Python 3.12 with facenet-pytorch in .venv is required to run the server." -ForegroundColor Yellow
}
