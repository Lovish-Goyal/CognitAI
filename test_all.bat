@echo off
REM CognitAI 1-Click Automated Test Runner
echo ======================================================
echo Launching CognitAI Automated Test Suite...
echo ======================================================
if exist backend\.venv\Scripts\python.exe (
    echo.
    echo --- Running Secure Biometric Attendance Test Suite (7 Verification Layers) ---
    backend\.venv\Scripts\python.exe backend\test_secure_attendance.py
    echo.
    echo --- Running System Telemetry & Attentiveness Test Suite ---
    backend\.venv\Scripts\python.exe run_all_tests.py
) else (
    python backend\test_secure_attendance.py
    python run_all_tests.py
)
pause
