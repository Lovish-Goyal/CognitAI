# CognitAI FastAPI Backend Launcher (PowerShell - Root)
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "Starting CognitAI FastAPI Backend Server on Port 8000..." -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

$backendDir = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "backend"
Set-Location $backendDir

$venvPython = ".\.venv\Scripts\python.exe"
if (Test-Path $venvPython) {
    Write-Host "Using backend virtual environment (.venv)..." -ForegroundColor Green
    & $venvPython -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
} else {
    Write-Host "[ERROR] Virtual environment (.venv) not found in $backendDir" -ForegroundColor Red
    Write-Host "Python 3.12 with facenet-pytorch in backend\.venv is required to run the server." -ForegroundColor Yellow
}
