@echo off
rem zn-gate hook launcher for the ZCode desktop app on Windows (plugin copy).
rem
rem hooks.json names this file as ${ZCODE_PLUGIN_ROOT}\scripts\zn-hook-win.cmd, an absolute path inside the plugin, so no
rem file of the project can run in its place. It starts the system PowerShell by its full path on zn-hook.ps1 (next to this
rem file) with the event name, which is only ever one of four fixed words: nothing the user or the project controls is
rem put on the command line. It blocks (exit code 2) when PowerShell or zn-hook.ps1 cannot start, or when the script ends
rem with any code other than 0 or 2, and it does so on every event except PostToolUse, where it only warns (exit code 0).
setlocal DisableDelayedExpansion
set "ZN_EVENT="
if /i "%~1"=="PreToolUse" set "ZN_EVENT=PreToolUse"
if /i "%~1"=="PermissionRequest" set "ZN_EVENT=PermissionRequest"
if /i "%~1"=="UserPromptSubmit" set "ZN_EVENT=UserPromptSubmit"
if /i "%~1"=="PostToolUse" set "ZN_EVENT=PostToolUse"
if not defined ZN_EVENT goto refuse
set "ZN_PS=C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
if defined SystemRoot set "ZN_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%ZN_PS%" goto refuse
if not exist "%~dp0zn-hook.ps1" goto refuse
"%ZN_PS%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0zn-hook.ps1" %ZN_EVENT%
set "ZN_RC=%ERRORLEVEL%"
if "%ZN_RC%"=="0" exit /b 0
if "%ZN_RC%"=="2" exit /b 2
:refuse
if "%ZN_EVENT%"=="PostToolUse" goto warn
echo zn: the plugin launcher (scripts/zn-hook-win.cmd) could not run. This call was blocked because zn could not check it. Ask the user to fix it, or to turn off the zn-gate plugin in ZCode (Settings, Plugins). 1>&2
exit /b 2
:warn
echo zn is NOT protecting this session: the plugin launcher (scripts/zn-hook-win.cmd) could not run. 1>&2
exit /b 0
