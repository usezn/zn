# Installs the tools on a clean Windows machine (Node.js, Git for Windows, the
# Codex CLI and OpenCode from npm) and runs the end-to-end harness on it.
# Meant for a throw-away VM: it installs software system-wide. Every value used
# by the runs is fake and the provider is the scripted one on 127.0.0.1.
#
#   powershell -ExecutionPolicy Bypass -File install_and_run.ps1 -Pkg <packages\zn-gate> -Out <dir> [-Work C:\e2e-work]
#
# <Pkg> is a copy of packages/zn-gate with its test\fixtures; this script is
# expected to sit in bench/e2e/windows/ next to ..\harness.
param(
  [Parameter(Mandatory = $true)][string]$Pkg,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Work = 'C:\e2e-work',
  [string]$NodeVersion = '22.12.0',
  [string]$GitVersion = '2.47.1'
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Force -Path $Out, $Work | Out-Null
$Log = Join-Path $Out 'install.log'
function Say([string]$t) { $l = '[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $t; Add-Content -Path $Log -Value $l -Encoding UTF8; Write-Host $l }
function Sh([string]$cmd, [int]$timeoutS = 300) {
  $tmp = Join-Path $Work ('sh-' + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.txt')
  $p = Start-Process -FilePath cmd.exe -ArgumentList "/d /s /c `"$cmd < NUL > `"$tmp`" 2>&1`"" -PassThru -WindowStyle Hidden
  if (-not $p.WaitForExit($timeoutS * 1000)) { & taskkill.exe /T /F /PID $p.Id | Out-Null; Say "TIMEOUT: $cmd" }
  $t = ''
  if (Test-Path $tmp) { $t = (Get-Content $tmp -Raw -ErrorAction SilentlyContinue) }
  if ($null -eq $t) { $t = '' }
  Say ("> $cmd [exit $($p.ExitCode)]`n" + $t.TrimEnd())
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$harness = (Resolve-Path (Join-Path $here '..\harness')).Path
$os = Get-CimInstance Win32_OperatingSystem
Say "OS: $($os.Caption) $($os.Version); PowerShell $($PSVersionTable.PSVersion)"

Say "install Node.js $NodeVersion"
Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-x64.msi" -OutFile (Join-Path $Work 'node.msi')
Start-Process msiexec.exe -ArgumentList "/i `"$Work\node.msi`" /qn /norestart" -Wait
Say "install Git for Windows $GitVersion"
try {
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/git-for-windows/git/releases/download/v$GitVersion.windows.1/Git-$GitVersion-64-bit.exe" -OutFile (Join-Path $Work 'git.exe')
  Start-Process (Join-Path $Work 'git.exe') -ArgumentList '/VERYSILENT /NORESTART /SUPPRESSMSGBOX' -Wait
} catch { Say "git install failed: $_" }
$env:Path = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;C:\Program Files\Git\bin;$env:APPDATA\npm;" + $env:Path
Sh 'node -v & npm.cmd -v & git --version'

Say 'install the agent CLIs'
Sh 'npm.cmd install -g @openai/codex' 600
Sh 'npm.cmd install -g opencode-ai' 600
Sh 'codex --version' 120
Sh 'opencode --version' 120
Sh 'where codex & where opencode' 60

Say 'install Python (for the command that is not approved)'
try {
  Invoke-WebRequest -UseBasicParsing -Uri 'https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe' -OutFile (Join-Path $Work 'python.exe')
  Start-Process (Join-Path $Work 'python.exe') -ArgumentList '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0' -Wait
} catch { Say "python install failed: $_" }
$env:Path = "C:\Program Files\Python312;C:\Program Files\Python312\Scripts;" + $env:Path
Sh 'python --version' 60

Say 'install the package dependencies'
Push-Location $Pkg
Sh 'npm.cmd install --omit=dev --no-audit --no-fund' 300
Pop-Location

Say 'run the harness'
$ev = Join-Path $Out 'evidence'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $harness 'run_all.ps1') -Pkg $Pkg -Work (Join-Path $Work 'runs') -Evidence $ev *>&1 | ForEach-Object { Say "$_" }
# Raw files for diagnosis (all values are fake).
foreach ($a in 'codex', 'opencode', 'opencode-git-bash') {
  $o = Join-Path $Work "runs\$a\out"
  if (Test-Path $o) {
    $d = Join-Path $Out "raw\$a"
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    Get-ChildItem $o -File | Copy-Item -Destination $d -Force
  }
}
Say 'finished'
