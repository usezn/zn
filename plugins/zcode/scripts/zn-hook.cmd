@echo off
rem The time of day this file started: ZCode's timeout for the hook runs from about here, and the deadlines count from it.
set "ZN_HOOK_T0=%TIME%"
rem zn-gate hook for the ZCode desktop app on Windows, fast path (plugin copy). The counterpart of zn-hook.ps1.
rem
rem Windows PowerShell takes 0.5 to 3 seconds to start, more than the integrity check of the plugin itself. This file
rem starts Node.js without it when Node.js is where the installer puts it (%ProgramFiles%\nodejs\node.exe, a folder only
rem an administrator can write to), and in every other case runs zn-hook.ps1 through PowerShell, exactly as before.
rem The check is the same in both paths: zn-launch.js verifies the zn-gate copy of the plugin byte for byte and runs it.
rem Nothing here decides anything about the call. Both paths answer by themselves (they block) 120 seconds after this file
rem started. ZCode lets a call run when its hook times out, so the plugin gives its hooks 5 minutes (hooks.json): with
rem every CPU busy, a stuck hook was blocked after at most 154 seconds in our tests.
rem
rem Usage (hooks.json): cmd.exe /d /c ( "<plugin folder>\scripts\zn-hook.cmd " <Event> ) || exit /b <2 or 0>
rem The event JSON arrives on stdin. Exit 0 lets the call run and exit 2 blocks it. Anything else, a Node.js that cannot
rem start included, blocks on PreToolUse, PermissionRequest and UserPromptSubmit and only warns on the other events.
rem
rem Every file is named from the folder of this file (%~dp0), never from ZCODE_PLUGIN_ROOT or the folder the hook runs in
rem (the project). Its value is only ever used inside quotes, so a folder name with spaces, &, parentheses, ^ or % in it
rem stays one path.
setlocal EnableExtensions DisableDelayedExpansion
set "ZN_HOOK_DIR=%~dp0"
set "ZN_EVENT=%~1"
set "ZN_CODE=2"
if /i "%ZN_EVENT%"=="PostToolUse" set "ZN_CODE=0"
if not defined SystemRoot set "SystemRoot=C:\Windows"
if not defined ProgramFiles goto :slow
set "ZN_NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%ZN_NODE%" goto :slow
rem A link is not used (the same rule as in zn-hook.ps1).
dir /a:l /b "%ZN_NODE%" >nul 2>nul && goto :slow
rem Node.js 20.19 or later with the module loader the launcher needs, else the PowerShell path looks for another one.
"%ZN_NODE%" -e "const v=process.versions.node.split('.').map(Number);const vm=require('vm');process.exit(((v[0]>21||(v[0]===21&&v[1]>=7)||(v[0]===20&&v[1]>=19))&&vm.constants&&vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER)?0:1)" <nul >nul 2>nul
if errorlevel 1 goto :slow
if not exist "%ZN_HOOK_DIR%zn-launch.js" goto :slow
"%ZN_NODE%" "%ZN_HOOK_DIR%zn-launch.js" hook zcode
set "ZN_RC=%ERRORLEVEL%"
if "%ZN_RC%"=="0" exit /b 0
if "%ZN_RC%"=="2" exit /b 2
if "%ZN_CODE%"=="2" (
  echo zn: the hook ended with exit code %ZN_RC%. This call was blocked because zn could not check it. Ask the user to fix it, or to turn off the zn-gate plugin in ZCode ^(Settings, Plugins^). 1>&2
) else (
  echo zn is NOT protecting this session: the hook ended with exit code %ZN_RC%. 1>&2
)
exit /b %ZN_CODE%

:slow
rem The inline command hooks.json used before this file, reading zn-hook.ps1 from the folder of this file (ZN_HOOK_DIR,
rem read by PowerShell, so the path is never part of the command line): it runs the script as a script block, so no
rem execution policy can stop it, and it blocks when the script cannot run.
if "%ZN_CODE%"=="2" (
  set "ZN_MSG=zn: the plugin launcher (scripts/zn-hook.ps1) could not run. This call was blocked because zn could not check it. Ask the user to fix it, or to turn off the zn-gate plugin in ZCode (Settings, Plugins)."
) else (
  set "ZN_MSG=zn is NOT protecting this session: the plugin launcher (scripts/zn-hook.ps1) could not run."
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "try { & ([scriptblock]::Create([IO.File]::ReadAllText($env:ZN_HOOK_DIR + 'zn-hook.ps1'))) '%ZN_EVENT%' } catch { [Console]::Error.WriteLine('%ZN_MSG%'); exit %ZN_CODE% }; exit %ZN_CODE%"
exit /b %ERRORLEVEL%
