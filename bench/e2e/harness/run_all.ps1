# Runs the end-to-end scenario on Windows for every agent CLI found (Codex and
# OpenCode) and writes the redacted evidence to <Evidence>\<agent>\ in the same
# layout as run_all.sh: summary.txt, leak-check.txt, confirmations.jsonl,
# exit-codes.txt, run.txt.
#
#   powershell -File run_all.ps1 -Pkg <packages\zn-gate> -Work <work dir> -Evidence <dir>
param(
  [Parameter(Mandatory = $true)][string]$Pkg,
  [Parameter(Mandatory = $true)][string]$Work,
  [Parameter(Mandatory = $true)][string]$Evidence
)
. (Join-Path $PSScriptRoot 'e2e_common.ps1')
$H = $PSScriptRoot
$Pkg = (Resolve-Path $Pkg).Path
$ErrorActionPreference = 'Continue'

function Save-Evidence([string]$Agent, [string]$Run, [string[]]$Sent, [string[]]$Local, [string]$Version) {
  $dir = Join-Path $Evidence $Agent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $sum = & node (Join-Path $H 'summarize_openai.js') $Run 2>&1
  Write-Utf8NoBom (Join-Path $dir 'summary.txt') (($sum -join "`n") + "`n")
  $leak = & node (Join-Path $H 'check_leaks.js') --values (Join-Path $Run 'values.json') --label sent @Sent --label local @Local 2>&1
  Write-Utf8NoBom (Join-Path $dir 'leak-check.txt') ((($leak -join "`n").Replace($Run, '<run>')) + "`n")
  foreach ($f in @(@('confirmations.jsonl', 'confirmations.jsonl'), @('exit_codes.txt', 'exit-codes.txt'))) {
    $src = Join-Path $Run ('out\' + $f[0])
    if (Test-Path $src) { Copy-Item $src (Join-Path $dir $f[1]) -Force }
  }
  $os = Get-CimInstance Win32_OperatingSystem
  Write-Utf8NoBom (Join-Path $dir 'run.txt') ("date: " + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mmZ') + "`nhost: Windows " + $os.Version + " ($($os.Caption)), PowerShell " + $PSVersionTable.PSVersion + ", node " + (& node -v) + "`nagent version: $Version`n")
}

$codex = Get-Command codex -ErrorAction SilentlyContinue
if ($codex) {
  $R = Join-Path $Work 'codex'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $H 'run_codex.ps1') -Pkg $Pkg -Run $R
  $o = Join-Path $R 'out'
  Save-Evidence 'codex' $R @((Join-Path $o 'requests.jsonl')) @((Join-Path $o 'transcripts'), (Join-Path $o 'codex_events.jsonl'), (Join-Path $o 'codex_paste_events.jsonl')) ((& cmd /c 'codex --version 2>&1') -join ' ')
} else { Write-Host 'codex not found: skipped' }

$oc = Get-Command opencode -ErrorAction SilentlyContinue
if ($oc) {
  $R = Join-Path $Work 'opencode'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $H 'run_opencode.ps1') -Pkg $Pkg -Run $R
  $o = Join-Path $R 'out'
  Save-Evidence 'opencode' $R @((Join-Path $o 'requests.jsonl')) @((Join-Path $R 'home\.local\share\opencode'), (Join-Path $o 'opencode_stdout.txt'), (Join-Path $o 'opencode_stderr.txt')) ((& cmd /c 'opencode --version 2>&1') -join ' ')
} else { Write-Host 'opencode not found: skipped' }
$bash = 'C:\Program Files\Git\bin\bash.exe'
if ($oc -and (Test-Path $bash)) {
  $R = Join-Path $Work 'opencode-git-bash'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $H 'run_opencode.ps1') -Pkg $Pkg -Run $R -Shell $bash
  $o = Join-Path $R 'out'
  Save-Evidence 'opencode-git-bash' $R @((Join-Path $o 'requests.jsonl')) @((Join-Path $R 'home\.local\share\opencode'), (Join-Path $o 'opencode_stdout.txt'), (Join-Path $o 'opencode_stderr.txt')) ((& cmd /c 'opencode --version 2>&1') -join ' ')
}
Get-ChildItem $Evidence -Recurse -Filter leak-check.txt | ForEach-Object { Get-Content $_.FullName }
