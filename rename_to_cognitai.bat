@echo off
setlocal
echo ========================================================
echo Renaming project root directory:
echo "Smart-Attendance-System" -^> "CognitAI"
echo ========================================================
cd /d "c:\Users\hp\OneDrive\Desktop"
if exist "CognitAI" (
    echo [WARNING] "CognitAI" folder already exists on Desktop!
    echo Please check your Desktop.
    pause
    exit /b 1
)
ren "Smart-Attendance-System" "CognitAI"
if %ERRORLEVEL% equ 0 (
    echo ========================================================
    echo [SUCCESS] Root directory successfully renamed to:
    echo C:\Users\hp\OneDrive\Desktop\CognitAI
    echo ========================================================
    echo Please open the 'CognitAI' folder in your IDE.
) else (
    echo ========================================================
    echo [NOTICE] Windows locked the directory because an IDE or
    echo terminal is currently open inside it.
    echo Close active servers, then re-run this script, or simply
    echo rename 'Smart-Attendance-System' to 'CognitAI' on Desktop.
    echo ========================================================
)
pause
