@echo off
rem fw-watchdog.cmd -- manual entry point for the framework-closure watchdog.
rem   usage: fw-watchdog.cmd --status | --once | --tick | (no args = resident)
rem NOTE: this file must keep CRLF line endings and ASCII-only comments --
rem   cmd.exe chokes on LF-only .cmd files and on multi-byte comments read in
rem   the OEM code page (measured: the comment text got executed as commands).
setlocal
set "WD=%~dp0fw-watchdog.mjs"
set "NODE="

rem (1) the node the desktop host passes down
if defined DSH_DESKTOP_NODE_EXECUTABLE if exist "%DSH_DESKTOP_NODE_EXECUTABLE%" set "NODE=%DSH_DESKTOP_NODE_EXECUTABLE%"

rem (2) the node bundled with the desktop runtime (most stable)
if not defined NODE (
  for %%D in ("D:\dsh-desktop" "%ProgramFiles%\DeepSeek Harness" "%LOCALAPPDATA%\Programs\DeepSeek Harness") do (
    if not defined NODE if exist "%%~D\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE=%%~D\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
  )
)

rem (3) whatever node is on PATH (last resort)
if not defined NODE for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE set "NODE=%%N"

if not defined NODE (
  echo [fw-watchdog] no usable node found -- install Node.js, or run this from the desktop install.
  exit /b 2
)

"%NODE%" "%WD%" %*
exit /b %ERRORLEVEL%
