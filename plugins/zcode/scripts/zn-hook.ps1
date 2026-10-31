# zn-gate hook for the ZCode desktop app on Windows (plugin copy). The counterpart of zn-hook.sh.
#
# hooks.json starts scripts/zn-hook-win.cmd (inside this plugin), which starts the system PowerShell on this file with
# -ExecutionPolicy Bypass and blocks when it cannot. This file does one job: it runs
# zn-launch.js, which checks the zn-gate copy shipped inside this plugin byte for byte and runs it, and when anything stops
# that from happening (no usable Node.js, a missing file, an unexpected exit code, a hang) it blocks instead of letting the
# call run: exit code 2 on PreToolUse, PermissionRequest and UserPromptSubmit, a warning only on the other events.
#
# Usage (as zn-hook-win.cmd runs it): the event name is the only argument; the event JSON arrives on stdin;
# ZCODE_PLUGIN_ROOT names the plugin folder.
#
# Node.js, in this order: node.exe in the absolute PATH entries of the hook outside the project (never one in the project
# folder, its git work tree or a node_modules folder), the usual install folders, and the program that runs ZCode's agent
# (the app's own Node.js, started with ELECTRON_RUN_AS_NODE=1: the parent of this process). A candidate is used only if it
# is Node.js 20.19 or later (21.7 or later on 21).
#
# Start deadline: the hooks of this plugin have a 30-second timeout and a call whose hook timed out ran, so after 28
# seconds the hook answers like it does when the check fails and stops the Node.js it started.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ZEvent = ''
if ($args.Count -gt 0) { $ZEvent = [string]$args[0] }
$Deadline = 28
$Clock = [System.Diagnostics.Stopwatch]::StartNew()

function Refuse([string]$why) {
  if (@('PreToolUse', 'PermissionRequest', 'UserPromptSubmit', '') -contains $ZEvent) {
    [Console]::Error.WriteLine('zn: ' + $why + ' This call was blocked because zn could not check it. Ask the user to fix it, or to turn off the zn-gate plugin in ZCode (Settings, Plugins).')
    exit 2
  }
  [Console]::Error.WriteLine('zn is NOT protecting this session: ' + $why)
  exit 0
}

function Left() { return [int][Math]::Max(0, ($Deadline * 1000) - $Clock.ElapsedMilliseconds) }

function Full([string]$p) {
  try { return [System.IO.Path]::GetFullPath($p).TrimEnd('\', '/') } catch { return $null }
}

function Absolute([string]$p) { return ($p -match '^[A-Za-z]:[\\/]') -or ($p -match '^\\\\[^\\]') }

# Folders the agent works in are not trusted for programs: the folder the hook runs in, the project folder the host names
# (CLAUDE_PROJECT_DIR, CURSOR_PROJECT_DIR) and the git work tree around the hook's folder, and any node_modules folder.
# Your home folder and the drive root never count as the project: everything would be untrusted there.
$HomeDir = Full $env:USERPROFILE
$Roots = New-Object System.Collections.ArrayList
function AddRoot([string]$p) {
  if (-not $p) { return }
  $f = Full $p
  if (-not $f) { return }
  if ($f.Length -le 3) { return }
  if ($HomeDir -and ($f -ieq $HomeDir)) { return }
  [void]$Roots.Add($f)
}
$Cwd = Full ([System.Environment]::CurrentDirectory)
AddRoot $Cwd
AddRoot $env:CLAUDE_PROJECT_DIR
AddRoot $env:CURSOR_PROJECT_DIR
$walk = $Cwd
while ($walk -and $walk.Length -gt 3) {
  if ([System.IO.Directory]::Exists($walk + '\.git') -or [System.IO.File]::Exists($walk + '\.git')) { AddRoot $walk; break }
  $walk = Full ([System.IO.Path]::GetDirectoryName($walk))
}

function TrustedDir([string]$dir) {
  $f = Full $dir
  if (-not $f) { return $false }
  if (($f + '\') -imatch '\\node_modules\\') { return $false }
  foreach ($r in $Roots) {
    if ($f -ieq $r -or $f.StartsWith($r + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  }
  return $true
}

# Only absolute, trusted PATH entries, for this script and everything it starts: a relative or empty entry points into the
# folder the session runs in (the project), where a node.exe of its own could have been placed.
$Safe = New-Object System.Collections.ArrayList
foreach ($e in ([string]$env:PATH).Split(';')) {
  if ($e -and (Absolute $e) -and (TrustedDir $e)) { [void]$Safe.Add($e.TrimEnd('\', '/')) }
}
if ($Safe.Count -eq 0) { [void]$Safe.Add($env:SystemRoot + '\System32') }
$env:PATH = ($Safe -join ';')

$Root = $env:ZCODE_PLUGIN_ROOT
$Launch = $null
if ($Root -and (Absolute $Root)) { $Launch = (Full $Root) + '\scripts\zn-launch.js' }
if (-not $Launch -or -not [System.IO.File]::Exists($Launch)) { Refuse 'the plugin launcher (scripts/zn-launch.js) is missing.' }

$Taskkill = $env:SystemRoot + '\System32\taskkill.exe'
function Stop-Tree($p) {
  try { & $Taskkill /PID $p.Id /T /F *> $null } catch {}
  try { $p.Kill() } catch {}
}

function New-Info([string]$file, [string]$arguments, [bool]$electron) {
  $i = New-Object System.Diagnostics.ProcessStartInfo
  $i.FileName = $file
  $i.Arguments = $arguments
  $i.UseShellExecute = $false
  $i.RedirectStandardInput = $true
  if ($electron) { $i.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1' }
  return $i
}

# Node.js 20.19+ with the module loader the launcher needs.
$Probe = "const v=process.versions.node.split('.').map(Number);const vm=require('vm');process.exit(((v[0]>21||(v[0]===21&&v[1]>=7)||(v[0]===20&&v[1]>=19))&&vm.constants&&vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER)?0:1)"
function NodeOk([string]$node) {
  $i = New-Info $node ('-e "' + $Probe + '"') $true
  $i.RedirectStandardOutput = $true
  $i.RedirectStandardError = $true
  $p = $null
  try {
    $p = [System.Diagnostics.Process]::Start($i)
    try { $p.StandardInput.Close() } catch {}
  } catch {
    return $false
  }
  if (-not $p.WaitForExit((Left))) {
    Stop-Tree $p
    Refuse ('the hook did not finish starting within ' + $Deadline + ' seconds.')
  }
  return ($p.ExitCode -eq 0)
}

$Node = $null
$AppNode = $false
function TryNode([string]$f) {
  if (-not $f -or -not [System.IO.File]::Exists($f)) { return $false }
  # A link is not followed: a node.exe that is a link is not used.
  try { if (([System.IO.File]::GetAttributes($f) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false } } catch { return $false }
  if (-not (TrustedDir ([System.IO.Path]::GetDirectoryName($f)))) { return $false }
  return (NodeOk $f)
}

# 1. PATH (absolute entries only, see above)
foreach ($e in $Safe) {
  $c = $e + '\node.exe'
  if (TryNode $c) { $Node = $c; break }
}
# 2. usual install folders
if (-not $Node) {
  $usual = @()
  if ($env:ProgramFiles) { $usual += ($env:ProgramFiles + '\nodejs\node.exe') }
  if (${env:ProgramFiles(x86)}) { $usual += (${env:ProgramFiles(x86)} + '\nodejs\node.exe') }
  if ($env:LOCALAPPDATA) { $usual += ($env:LOCALAPPDATA + '\Programs\nodejs\node.exe') }
  if ($env:USERPROFILE) { $usual += ($env:USERPROFILE + '\.volta\bin\node.exe') }
  foreach ($c in $usual) { if (TryNode $c) { $Node = $c; break } }
}
# 3. the program that started this hook (ZCode's own Node.js)
if (-not $Node) {
  $exe = $null
  try {
    $me = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $PID)
    $parent = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $me.ParentProcessId)
    $exe = [string]$parent.ExecutablePath
  } catch { $exe = $null }
  if ($exe -and (Absolute $exe) -and (TryNode $exe)) { $Node = $exe; $AppNode = $true }
}
if (-not $Node) { Refuse 'no Node.js 20.19 or later was found for the hook (looked in the PATH, the usual install folders and the app itself).' }

# The launcher exits 0 (done) or 2 (blocked) by itself; anything else is a failure and is refused here. The event JSON on
# stdin is passed on; the launcher's answer goes straight to this process's output.
$rc = -1
$i = New-Info $Node ('"' + $Launch + '" hook zcode') $AppNode
$p = $null
$started = $false
try {
  $p = [System.Diagnostics.Process]::Start($i)
  $started = $true
} catch {
  $rc = -1
}
if ($started) {
  try {
    $c = [Console]::OpenStandardInput().CopyToAsync($p.StandardInput.BaseStream)
    [void]$c.Wait((Left))
  } catch {}
  try { $p.StandardInput.Close() } catch {}
  if ($p.WaitForExit((Left))) { $rc = $p.ExitCode } else {
    Stop-Tree $p
    Refuse ('the hook did not finish starting within ' + $Deadline + ' seconds.')
  }
}
if ($rc -eq 0 -or $rc -eq 2) { exit $rc }
Refuse ('the hook ended with exit code ' + $rc + '.')
