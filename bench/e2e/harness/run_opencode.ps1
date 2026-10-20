# End-to-end run of OpenCode with the zn plugin against the scripted provider
# (OpenAI Chat Completions on 127.0.0.1), on Windows. Every value is fake.
# PowerShell port of run_opencode.sh.
#
#   powershell -File run_opencode.ps1 -Pkg <packages\zn-gate> -Run <run dir> [-OpenCode opencode] [-Shell <bash.exe>]
#
# -Shell sets SHELL for the run, which OpenCode uses for its bash tool. Without it
# OpenCode picks its default shell on Windows.
param(
  [Parameter(Mandatory = $true)][string]$Pkg,
  [Parameter(Mandatory = $true)][string]$Run,
  [string]$OpenCode = 'opencode',
  [string]$Shell = '',
  [int]$Port = 8789
)
. (Join-Path $PSScriptRoot 'e2e_common.ps1')
$H = $PSScriptRoot
$Pkg = (Resolve-Path $Pkg).Path
$NodeExe = (Get-Command node).Source
if (Test-Path $Run) { Remove-Item -Recurse -Force $Run }
New-Item -ItemType Directory -Force -Path $Run | Out-Null
$Run = (Resolve-Path $Run).Path
& node (Join-Path $H 'setup.js') --pkg $Pkg --run $Run --agent opencode | Out-Null
if ($LASTEXITCODE -ne 0) { throw "setup.js failed ($LASTEXITCODE)" }
$Out = Join-Path $Run 'out'
$HomeDir = Join-Path $Run 'home'
New-Item -ItemType Directory -Force -Path (Join-Path $Run 'bin') | Out-Null
Write-Utf8NoBom (Join-Path $Run 'bin\zn.cmd') ("@echo off`r`n`"$NodeExe`" `"$Pkg\bin\cli.js`" %*`r`n")
$env:HOME = $HomeDir; $env:USERPROFILE = $HomeDir
$env:HOMEDRIVE = (Split-Path -Qualifier $HomeDir); $env:HOMEPATH = $HomeDir.Substring($env:HOMEDRIVE.Length)
$env:APPDATA = Join-Path $HomeDir 'AppData\Roaming'; $env:LOCALAPPDATA = Join-Path $HomeDir 'AppData\Local'
New-Item -ItemType Directory -Force -Path $env:APPDATA, $env:LOCALAPPDATA | Out-Null
$env:ZN_HOME = Join-Path $Run 'zn'
$env:XDG_CONFIG_HOME = Join-Path $HomeDir '.config'; $env:XDG_DATA_HOME = Join-Path $HomeDir '.local\share'
$env:XDG_STATE_HOME = Join-Path $HomeDir '.local\state'; $env:XDG_CACHE_HOME = Join-Path $HomeDir '.cache'
if ($Shell) { $env:SHELL = $Shell }
$env:MOCK_API_KEY = 'mock-provider-key'; $env:OPENCODE_DISABLE_AUTOUPDATE = '1'; $env:OPENCODE_DISABLE_SHARE = '1'
$env:PATH = (Join-Path $Run 'bin') + ';' + (Split-Path $NodeExe) + ';' + $env:PATH
$py3 = Ensure-Python3 (Join-Path $Run 'bin')
Write-Host "python3 available: $py3"
New-Item -ItemType Directory -Force -Path (Join-Path $env:XDG_CONFIG_HOME 'opencode') | Out-Null
Write-Utf8NoBom (Join-Path $env:XDG_CONFIG_HOME 'opencode\opencode.json') @"
{
  "`$schema": "https://opencode.ai/config.json",
  "model": "mock/mock-model",
  "share": "disabled",
  "autoupdate": false,
  "permission": { "bash": "allow", "edit": "allow", "read": "allow", "webfetch": "deny", "external_directory": "allow" },
  "provider": {
    "mock": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "mock",
      "options": { "baseURL": "http://127.0.0.1:$Port/v1", "apiKey": "{env:MOCK_API_KEY}" },
      "models": { "mock-model": { "name": "mock-model", "tool_call": true } }
    }
  }
}
"@

# Records what the plugin process sees: which shell variables are set when OpenCode
# loads a plugin and runs a bash tool call (used to check how zn picks the shell).
$plug = Join-Path $env:XDG_CONFIG_HOME 'opencode\plugins'
New-Item -ItemType Directory -Force -Path $plug | Out-Null
$probeOut = (Join-Path $Run 'out\shell-probe.txt').Replace('\', '/')
Write-Utf8NoBom (Join-Path $plug 'shell-probe.js') @"
import fs from 'node:fs';
const log = (w) => fs.appendFileSync('$probeOut', w + ' platform=' + process.platform + ' SHELL=' + JSON.stringify(process.env.SHELL) + ' ComSpec=' + JSON.stringify(process.env.ComSpec) + ' PSModulePath_set=' + (process.env.PSModulePath ? 'yes' : 'no') + '\n');
export default async () => { log('load'); return { 'tool.execute.before': async (input) => { if (input && input.tool === 'bash') log('bash-call'); } }; };
"@

$vault = Start-Node @((Join-Path $H 'vault_daemon.js'), '--pkg', $Pkg, '--secrets', (Join-Path $Run 'secrets.json'), '--out', $Out) (Join-Path $Out 'vault.log') (Join-Path $Out 'vault.err')
$mock = Start-Node @((Join-Path $H 'mock_llm.js'), '--port', "$Port", '--script', (Join-Path $Run 'scenario.json'), '--out', $Out) (Join-Path $Out 'mock.log') (Join-Path $Out 'mock.err')
try {
  if (-not (Wait-File (Join-Path $Out 'vault.ready') 15)) {
    if (Test-Path (Join-Path $Out 'vault.error')) { Get-Content (Join-Path $Out 'vault.error') }
    throw 'vault did not start'
  }
  $pkgJs = $Pkg.Replace('\', '/')
  & node -e "require('$pkgJs/lib/agents/opencode').install({ scope: 'user', mcp: false })" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'opencode plugin install failed' }
  $proj = Join-Path $Run 'proj'
  $rc1 = Invoke-Logged "`"$OpenCode`" run --print-logs `"Follow the setup task.`"" (Join-Path $Out 'opencode_stdout.txt') (Join-Path $Out 'opencode_stderr.txt') 300 $proj
  $pasted = (Get-Content (Join-Path $Run 'pasted.txt') -Raw).Trim()
  $rc2 = Invoke-Logged "`"$OpenCode`" run `"$pasted`"" (Join-Path $Out 'opencode_paste_stdout.txt') (Join-Path $Out 'opencode_paste_stderr.txt') 120 $proj
  Write-Utf8NoBom (Join-Path $Out 'exit_codes.txt') ("task exit=$rc1`npaste exit=$rc2`n")
  $store = Join-Path $env:XDG_DATA_HOME 'opencode\storage'
  if (Test-Path $store) { Copy-Item -Recurse -Force $store (Join-Path $Out 'transcripts') }
} finally {
  Stop-Tree $vault; Stop-Tree $mock
}
'done'
