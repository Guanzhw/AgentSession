@echo off
setlocal

if not "%OPENSESSIONVIEWER_QA_BASH_PATH%"=="" (
  set "QA_BASH=%OPENSESSIONVIEWER_QA_BASH_PATH%"
) else if exist "D:\Program Files\Git\usr\bin\bash.exe" (
  set "QA_BASH=D:\Program Files\Git\usr\bin\bash.exe"
) else if exist "C:\Program Files\Git\usr\bin\bash.exe" (
  set "QA_BASH=C:\Program Files\Git\usr\bin\bash.exe"
) else if exist "C:\cygwin64\bin\bash.exe" (
  set "QA_BASH=C:\cygwin64\bin\bash.exe"
) else if exist "C:\cygwin\bin\bash.exe" (
  set "QA_BASH=C:\cygwin\bin\bash.exe"
) else (
  echo Git Bash or Cygwin Bash is required. Set OPENSESSIONVIEWER_QA_BASH_PATH to bash.exe.
  exit /b 1
)

if "%OPENSESSIONVIEWER_QA_PORT%"=="" set "OPENSESSIONVIEWER_QA_PORT=3470"

"%QA_BASH%" -lc "cd \"$(cygpath -u '%~dp0..')\" && scripts/qa-agent-browser.sh"
exit /b %ERRORLEVEL%
