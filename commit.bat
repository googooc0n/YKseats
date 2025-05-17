@echo off
REM === Auto-commit and push batch script with safe.directory fix ===
REM Usage: commit.bat "Your commit message"

\:: Change to project directory (where this script is located)
cd /d "%\~dp0"

\:: Determine repository path without trailing backslash
set "REPO\_PATH=%CD%"

echo Adding "%REPO\_PATH%" to git safe.directory list...
"%ProgramFiles%\Git\cmd\git.exe" config --global --add safe.directory "%REPO\_PATH%"

\:: Determine commit message
if "%\~1"=="" (
set "MSG=Auto commit"
) else (
set "MSG=%\~1"
)

echo Staging all changes...
"%ProgramFiles%\Git\cmd\git.exe" add .
if errorlevel 1 (
echo Error staging files.
pause
exit /b 1
)

echo Committing with message: %MSG%
"%ProgramFiles%\Git\cmd\git.exe" commit -m "%MSG%"
if errorlevel 1 (
echo Nothing to commit or commit failed.
) else (
echo Pushing to origin main...
"%ProgramFiles%\Git\cmd\git.exe" push -u origin main
)

echo Done.
pause
