@echo off
REM CognitAI 1-Click Automated Test Runner
echo ======================================================
echo Launching CognitAI Automated Test Suite...
echo ======================================================
if exist backend\.venv\Scripts\python.exe (
    backend\.venv\Scripts\python.exe run_all_tests.py
) else (
    python run_all_tests.py
)
pause
