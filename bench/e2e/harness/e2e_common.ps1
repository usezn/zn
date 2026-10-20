# Shared helpers for the Windows end-to-end scripts (dot-sourced). Every value is fake.
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# Runs a command line through cmd.exe with stdin closed, output to files and a timeout.
# Returns the exit code (124 on timeout; the whole process tree is killed).
function Invoke-Logged([string]$CommandLine, [string]$OutFile, [string]$ErrFile, [int]$TimeoutSec, [string]$WorkDir) {
  $line = "$CommandLine < NUL > `"$OutFile`" 2> `"$ErrFile`""
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'cmd.exe'
  $psi.Arguments = "/d /s /c `"$line`""
  $psi.WorkingDirectory = $WorkDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  if (-not $p.WaitForExit($TimeoutSec * 1000)) {
    & taskkill.exe /T /F /PID $p.Id | Out-Null
    return 124
  }
  return $p.ExitCode
}

function Start-Node([string[]]$NodeArgs, [string]$OutFile, [string]$ErrFile) {
  $q = ($NodeArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
  return Start-Process -FilePath node -ArgumentList $q -PassThru -WindowStyle Hidden -RedirectStandardOutput $OutFile -RedirectStandardError $ErrFile
}

function Wait-File([string]$Path, [int]$Seconds) {
  for ($i = 0; $i -lt ($Seconds * 5); $i++) { if (Test-Path $Path) { return $true }; Start-Sleep -Milliseconds 200 }
  return (Test-Path $Path)
}

# The scripted task runs `python3 ...` as the command the user does not approve.
# Windows has no `python3`: when a Python is installed, put a copy of python.exe
# named python3.exe in the run's bin folder so the same command is found (zn
# declines it before it would start). Returns $true when python3 now resolves.
function Ensure-Python3([string]$BinDir) {
  if (Get-Command python3.exe -ErrorAction SilentlyContinue) { return $true }
  $py = Get-Command python.exe -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike '*\WindowsApps\*' } | Select-Object -First 1
  if (-not $py) { return $false }
  Copy-Item $py.Source (Join-Path $BinDir 'python3.exe') -Force
  return $true
}

function Stop-Tree($Proc) {
  if ($Proc -and -not $Proc.HasExited) { & taskkill.exe /T /F /PID $Proc.Id | Out-Null }
}
