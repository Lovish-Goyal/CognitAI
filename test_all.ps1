# CognitAI 1-Click Automated Test Runner (PowerShell)
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "Launching CognitAI Comprehensive Automated Test Suite..." -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan

$venvPython = "backend\.venv\Scripts\python.exe"
if (Test-Path $venvPython) {
    Write-Host "`n--- Running Secure Biometric Attendance Test Suite (7 Verification Layers) ---" -ForegroundColor Yellow
    & $venvPython backend\test_secure_attendance.py
    Write-Host "`n--- Running System Telemetry & Attentiveness Test Suite ---" -ForegroundColor Yellow
    & $venvPython run_all_tests.py
} else {
    python backend\test_secure_attendance.py
    python run_all_tests.py
}
