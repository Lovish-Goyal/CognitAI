# CognitAI 1-Click Automated Test Runner (PowerShell)
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "Launching CognitAI Comprehensive Automated Test Suite..." -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan

$venvPython = "backend\.venv\Scripts\python.exe"
if (Test-Path $venvPython) {
    & $venvPython run_all_tests.py
} else {
    python run_all_tests.py
}
