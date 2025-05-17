@echo off
REM =============================================
REM Auto-commit & push all changes batch script
REM Usage: Double-click or run from command line
REM =============================================

:: Change to script directory (project root)
cd /d "%~dp0"

:: Add current directory to git safe list (handle dubious ownership)
git config --global --add safe.directory "%~dp0"

:: Stage all changes
echo Staging all changes...
git add .

:: Commit with timestamp message
echo Committing changes...
git commit -m "Auto commit %DATE% %TIME%"

:: Push to main branch
echo Pushing to origin main...
git push origin main

echo.
echo Done. Press any key to exit.
pause