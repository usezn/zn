# End-to-end run of the Codex CLI with the zn hooks against the scripted
# provider (OpenAI Responses API on 127.0.0.1), on Windows. Every value is fake.
# PowerShell port of run_codex.sh.
#
#   powershell -File run_codex.ps1 -Pkg <packages\zn-gate> -Run <run dir> [-Codex codex] [-Sandbox bypass]
#
# -Sandbox: "bypass" (default: --dangerously-bypass-approvals-and-sandbox) or a
# Codex sandbox mode such as workspace-write. Hooks are trusted for the run with
# --dangerously-bypass-hook-trust (what /hooks would record).
param(
  [Parameter(Mandatory = $true)][string]$Pkg,
  [Parameter(Mandatory = $true)][string]$Run,
  [string]$Codex = 'codex',
  [string]$Sandbox = 'bypass',
  [int]$Port = 8788
)
. (Join-Path $PSScriptRoot 'e2e_common.ps1')
$H = $PSScriptRoot
$Pkg = (Resolve-Path $Pkg).Path
$NodeExe = (Get-Command node).Source
if (Test-Path $Run) { Remove-Item -Recurse -Force $Run }
New-Item -ItemType Directory -Force -Path $Run | Out-Null
$Run = (Resolve-Path $Run).Path
& node (Join-Path $H 'setup.js') --pkg $Pkg --run $Run --agent codex | Out-Null
if ($LASTEXITCODE -ne 0) { throw "setup.js failed ($LASTEXITCODE)" }
$Out = Join-Path $Run 'out'
$HomeDir = Join-Path $Run 'home'
$CodexHome = Join-Path $HomeDir '.codex'
New-Item -ItemType Directory -Force -Path (Join-Path $Run 'bin'), $CodexHome | Out-Null
# `zn` on the PATH, as an npm global install would provide it.
Write-Utf8NoBom (Join-Path $Run 'bin\zn.cmd') ("@echo off`r`n`"$NodeExe`" `"$Pkg\bin\cli.js`" %*`r`n")
$env:HOME = $HomeDir; $env:USERPROFILE = $HomeDir
$env:HOMEDRIVE = (Split-Path -Qualifier $HomeDir); $env:HOMEPATH = $HomeDir.Substring($env:HOMEDRIVE.Length)
$env:ZN_HOME = Join-Path $Run 'zn'; $env:CODEX_HOME = $CodexHome; $env:MOCK_API_KEY = 'mock-provider-key'
$env:PATH = (Join-Path $Run 'bin') + ';' + (Split-Path $NodeExe) + ';' + $env:PATH
$py3 = Ensure-Python3 (Join-Path $Run 'bin')
Write-Host "python3 available: $py3"
Write-Utf8NoBom (Join-Path $CodexHome 'config.toml') @"
model = "mock-model"
model_provider = "mock"
[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:$Port/v1"
env_key = "MOCK_API_KEY"
wire_api = "responses"
"@

$vault = Start-Node @((Join-Path $H 'vault_daemon.js'), '--pkg', $Pkg, '--secrets', (Join-Path $Run 'secrets.json'), '--out', $Out) (Join-Path $Out 'vault.log') (Join-Path $Out 'vault.err')
$mock = Start-Node @((Join-Path $H 'mock_llm.js'), '--port', "$Port", '--script', (Join-Path $Run 'scenario.json'), '--out', $Out) (Join-Path $Out 'mock.log') (Join-Path $Out 'mock.err')
try {
  if (-not (Wait-File (Join-Path $Out 'vault.ready') 15)) {
    if (Test-Path (Join-Path $Out 'vault.error')) { Get-Content (Join-Path $Out 'vault.error') }
    throw 'vault did not start'
  }
  $pkgJs = $Pkg.Replace('\', '/')
  & node -e "require('$pkgJs/lib/agents/codex').install({ scope: 'user', mcp: false })" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'codex hook install failed' }
  $sb = if ($Sandbox -eq 'bypass') { '--dangerously-bypass-approvals-and-sandbox' } else { "-s $Sandbox" }
  $proj = Join-Path $Run 'proj'
  $base = "`"$Codex`" exec --skip-git-repo-check --dangerously-bypass-hook-trust $sb --json"
  $rc1 = Invoke-Logged "$base `"Follow the setup task.`"" (Join-Path $Out 'codex_events.jsonl') (Join-Path $Out 'codex_stderr.txt') 300 $proj
  $pasted = (Get-Content (Join-Path $Run 'pasted.txt') -Raw).Trim()
  $rc2 = Invoke-Logged "$base `"$pasted`"" (Join-Path $Out 'codex_paste_events.jsonl') (Join-Path $Out 'codex_paste_stderr.txt') 300 $proj
  Write-Utf8NoBom (Join-Path $Out 'exit_codes.txt') ("task exit=$rc1`npaste exit=$rc2`n")
  if (Test-Path (Join-Path $CodexHome 'sessions')) { Copy-Item -Recurse -Force (Join-Path $CodexHome 'sessions') (Join-Path $Out 'transcripts') }
} finally {
  Stop-Tree $vault; Stop-Tree $mock
}
'done'
