# zn-gate hook for the ZCode desktop app on Windows (plugin copy). The counterpart of zn-hook.sh.
#
# scripts/zn-hook.cmd (and, in earlier plugin versions, hooks.json) starts this file with a small inline PowerShell command
# that reads it and runs it as a script block, so no execution policy (Restricted, AllSigned, a group policy) can stop it
# from running. It does one job: it runs
# zn-launch.js, which checks the zn-gate copy shipped inside this plugin byte for byte and runs it, and when anything stops
# that from happening (no usable Node.js, a missing file, an unexpected exit code, a hang) it blocks instead of letting the
# call run: exit code 2 on PreToolUse, PermissionRequest and UserPromptSubmit, a warning only on the other events.
#
# Usage (as the inline command runs it): the event name is the only argument; the event JSON arrives on stdin;
# ZN_HOOK_DIR (the scripts folder, set by zn-hook.cmd) or else ZCODE_PLUGIN_ROOT names where the plugin is.
#
# Node.js, in this order: node.exe in the absolute PATH entries of the hook outside the project (never one in the project
# folder, its git work tree or a node_modules folder), the usual install folders, and the program that runs ZCode's agent
# (the app's own Node.js, started with ELECTRON_RUN_AS_NODE=1: the parent of this process). A candidate is used only if it
# is Node.js 20.19 or later (21.7 or later on 21).
#
# Start deadline: a call whose hook timed out runs in ZCode, so after 120
# seconds the hook answers like it does when the check fails and stops the Node.js it started. Every wait has a limit taken
# from the time that is left. The script uses no PowerShell command (Get-Date, New-Object, Get-CimInstance, ...), only the
# language and .NET: Windows PowerShell finds a command by reading its module folders, and without its module cache (a new
# user, or a hook started with few environment variables) that alone can take many seconds. The deadline is 2 minutes because
# on a busy CPU an ordinary check took up to 131 seconds as ZCode times it (process start and end included); the plugin gives
# its hooks 5 minutes in ZCode (hooks.json), more than this deadline: with every CPU busy a stuck hook was blocked after at
# most 154 seconds.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ZEvent = ''
if ($args.Count -gt 0) { $ZEvent = [string]$args[0] }
$Deadline = 120
$Total = $Deadline
$Clock = [System.Diagnostics.Stopwatch]::StartNew()
# ZCode's timeout counts from the moment it starts the hook, and Windows PowerShell can take seconds to start on a cold
# machine: the deadline is the time that is left of those 120 seconds, so a slow start blocks the call instead of running into
# the timeout. The time is counted from the start of this process or, when scripts/zn-hook.cmd started it, from the first
# line of that file (ZN_HOOK_T0, the time of day cmd.exe read there), whichever is earlier. ZN_HOOK_T0 can only make the
# deadline shorter.
try {
  $Since = ([DateTime]::Now - [System.Diagnostics.Process]::GetCurrentProcess().StartTime).TotalSeconds
  if ([string]$env:ZN_HOOK_T0 -match '^\s*(\d{1,2})\D(\d{2})\D(\d{2})\D(\d{2})\s*$') {
    $t0 = [int]$Matches[1] * 3600 + [int]$Matches[2] * 60 + [int]$Matches[3] + [int]$Matches[4] / 100
    $e = [DateTime]::Now.TimeOfDay.TotalSeconds - $t0
    if ($e -lt 0) { $e += 86400 }
    if ($e -gt $Since -and $e -lt 120) { $Since = $e }
  }
  $Deadline = [Math]::Max(0, $Deadline - [int][Math]::Ceiling($Since))
} catch {}

# The process ends here at once ([Environment]::Exit), also when a lookup given up at its time limit is still running in the
# background.
function Refuse([string]$why) {
  if (@('PreToolUse', 'PermissionRequest', 'UserPromptSubmit', '') -contains $ZEvent) {
    [Console]::Error.WriteLine('zn: ' + $why + ' This call was blocked because zn could not check it. Ask the user to fix it, or to turn off the zn-gate plugin in ZCode (Settings, Plugins).')
    [Environment]::Exit(2)
  }
  [Console]::Error.WriteLine('zn is NOT protecting this session: ' + $why)
  [Environment]::Exit(0)
}

function Left() { return [int][Math]::Max(0, ($Deadline * 1000) - $Clock.ElapsedMilliseconds) }

if ($Deadline -le 0) { Refuse ('the hook took too long to start to finish within ' + $Total + ' seconds.') }

function Full([string]$p) {
  try { return [System.IO.Path]::GetFullPath($p).TrimEnd('\', '/') } catch { return $null }
}

function Absolute([string]$p) { return ($p -match '^[A-Za-z]:[\\/]') -or ($p -match '^\\\\[^\\]') }

# Folders the agent works in are not trusted for programs: the folder the hook runs in, the project folder the host names
# (CLAUDE_PROJECT_DIR, CURSOR_PROJECT_DIR) and the git work tree around the hook's folder, and any node_modules folder.
# Your home folder and the drive root never count as the project: everything would be untrusted there.
$HomeDir = Full $env:USERPROFILE
$Roots = [System.Collections.ArrayList]::new()
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
$Safe = [System.Collections.ArrayList]::new()
foreach ($e in ([string]$env:PATH).Split(';')) {
  if ($e -and (Absolute $e) -and (TrustedDir $e)) { [void]$Safe.Add($e.TrimEnd('\', '/')) }
}
if ($Safe.Count -eq 0) { [void]$Safe.Add($env:SystemRoot + '\System32') }
$env:PATH = ($Safe -join ';')

# The plugin folder: the parent of the folder scripts/zn-hook.cmd ran from (ZN_HOOK_DIR, set by that file) or, for the
# PowerShell entry of earlier plugin versions, ZCODE_PLUGIN_ROOT. Never a path relative to the folder the hook runs in.
$Root = $env:ZCODE_PLUGIN_ROOT
if ($env:ZN_HOOK_DIR) { $Root = [System.IO.Path]::GetDirectoryName(([string]$env:ZN_HOOK_DIR).TrimEnd('\', '/')) }
$Launch = $null
if ($Root -and (Absolute $Root)) { $Launch = (Full $Root) + '\scripts\zn-launch.js' }
if (-not $Launch -or -not [System.IO.File]::Exists($Launch)) { Refuse 'the plugin launcher (scripts/zn-launch.js) is missing.' }

$Taskkill = $env:SystemRoot + '\System32\taskkill.exe'
function Stop-Tree($p) {
  try { & $Taskkill /PID $p.Id /T /F *> $null } catch {}
  try { $p.Kill() } catch {}
}

function New-Info([string]$file, [string]$arguments, [bool]$electron) {
  $i = [System.Diagnostics.ProcessStartInfo]::new()
  $i.FileName = $file
  $i.Arguments = $arguments
  $i.UseShellExecute = $false
  $i.RedirectStandardInput = $true
  if ($electron) { $i.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1' }
  return $i
}

# Node.js 20.19+ with the module loader the launcher needs. The probe prints its own version; the answer is read and checked
# here, so a program that is not Node.js (cmd.exe, PowerShell, ...) and ends with exit code 0 is never taken for it.
$Probe = "const vm=require('vm');process.stdout.write('ZNPROBE '+process.versions.node+' '+((vm.constants&&vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER)?'1':'0'))"
function VersionOk([string]$out) {
  $m = [regex]::Match($out.Trim(), '^ZNPROBE (\d+)\.(\d+)\.\d+ 1$')
  if (-not $m.Success) { return $false }
  $maj = [int]$m.Groups[1].Value
  $min = [int]$m.Groups[2].Value
  return ($maj -gt 21) -or ($maj -eq 21 -and $min -ge 7) -or ($maj -eq 20 -and $min -ge 19)
}
function NodeOk([string]$node) {
  $i = New-Info $node ('-e "' + $Probe + '"') $true
  $i.RedirectStandardOutput = $true
  $i.RedirectStandardError = $true
  $p = $null
  $outTask = $null
  try {
    $p = [System.Diagnostics.Process]::Start($i)
    $outTask = $p.StandardOutput.ReadToEndAsync()
    [void]$p.StandardError.ReadToEndAsync()
    try { $p.StandardInput.Close() } catch {}
  } catch {
    return $false
  }
  if (-not $p.WaitForExit((Left))) {
    Stop-Tree $p
    Refuse ('the hook did not finish starting within ' + $Total + ' seconds.')
  }
  if ($p.ExitCode -ne 0) { return $false }
  try {
    if (-not $outTask.Wait(2000)) { return $false }
    return (VersionOk ([string]$outTask.Result))
  } catch { return $false }
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
# 3. the program that started this hook (ZCode's own Node.js). The hook runs under scripts/zn-hook.cmd, so the parent is
# usually cmd.exe: shells and script hosts are skipped and the chain is walked up (at most 6 levels) to the first program that
# is not one of them, the only one tried. Whatever is picked must still pass the probe above, which parses the version
# Node.js prints.
# The chain is read from WMI one process at a time (not a list of every process), in a runspace of its own: the hook waits
# for it only until 2 seconds before its deadline, so a WMI service that is slow to answer or to start cannot hold the hook
# past it (no parent is then tried, and the hook blocks).
if (-not $Node) {
  $skip = @('cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe', 'wscript.exe', 'cscript.exe', 'bash.exe', 'sh.exe', 'wsl.exe', 'explorer.exe', 'services.exe', 'svchost.exe', 'wininit.exe', 'winlogon.exe')
  $chain = @()
  $wait = (Left) - 2000
  if ($wait -gt 0) {
    try {
      $lookup = [PowerShell]::Create([System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault2())
      [void]$lookup.AddScript({
        param([int]$id, [string[]]$skip)
        # The program of each ancestor, from the parent of this process up, until the first one that is not a shell.
        for ($n = 0; $n -lt 6; $n++) {
          $row = $null
          foreach ($o in ([wmisearcher]('SELECT ParentProcessId FROM Win32_Process WHERE ProcessId = ' + $id)).Get()) { $row = $o }
          if (-not $row) { break }
          $id = [int]$row.ParentProcessId
          if ($id -le 4) { break }
          $exe = $null
          foreach ($o in ([wmisearcher]('SELECT ExecutablePath FROM Win32_Process WHERE ProcessId = ' + $id)).Get()) { $exe = [string]$o.ExecutablePath }
          if ($null -eq $exe) { break }
          [string]$exe
          if ($exe -and -not ($skip -contains ([System.IO.Path]::GetFileName($exe).ToLowerInvariant()))) { break }
        }
      }).AddArgument($PID).AddArgument($skip)
      $async = $lookup.BeginInvoke()
      if ($async.AsyncWaitHandle.WaitOne($wait)) { $chain = @($lookup.EndInvoke($async)) }
    } catch { $chain = @() }
  }
  for ($lvl = 0; $lvl -lt 6 -and $lvl -lt $chain.Count -and -not $Node; $lvl++) {
    $exe = [string]$chain[$lvl]
    if (-not $exe -or -not (Absolute $exe)) { continue }
    if ($skip -contains ([System.IO.Path]::GetFileName($exe).ToLowerInvariant())) { continue }
    if (TryNode $exe) { $Node = $exe; $AppNode = $true }
    break
  }
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
    Refuse ('the hook did not finish starting within ' + $Total + ' seconds.')
  }
}
if ($rc -eq 0 -or $rc -eq 2) { exit $rc }
Refuse ('the hook ended with exit code ' + $rc + '.')
