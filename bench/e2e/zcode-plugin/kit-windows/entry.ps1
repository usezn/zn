$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$O = 'C:\zout'; New-Item -ItemType Directory -Force $O | Out-Null
function M($s) { $l = "[$((Get-Date).ToUniversalTime().ToString('s'))Z] $s"; Add-Content "$O\meta.txt" $l; Write-Host $l }
function Finish { Copy-Item "$O\*" $env:ZN_OUT -Recurse -Force -ErrorAction Continue }
$KIT = $PSScriptRoot
if (-not $KIT) { $KIT = (Get-Location).Path }
M "OS: $((Get-CimInstance Win32_OperatingSystem).Caption) $((Get-CimInstance Win32_OperatingSystem).Version) whoami=$(whoami)"
New-Item -ItemType Directory -Force C:\dl | Out-Null
$url = 'https://cdn-zcode.z.ai/zcode/electron/releases/3.16.3/windows-x64/ZCode-3.16.3-win-x64.exe'
$inst = 'C:\dl\ZCode-win-x64.exe'
Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $inst
M "installer url=$url sha256=$((Get-FileHash $inst -Algorithm SHA256).Hash) size=$((Get-Item $inst).Length)"
M "installer signature=$((Get-AuthenticodeSignature $inst).Status)"
$p = Start-Process -FilePath $inst -ArgumentList '/S', '/D=C:\ZCodeApp' -PassThru -Wait
M "installer exit=$($p.ExitCode)"
Start-Sleep 8
Get-Process | Where-Object { $_.Path -like 'C:\ZCodeApp*' } | ForEach-Object { Stop-Process -Id $_.Id -Force }
$exe = 'C:\ZCodeApp\ZCode.exe'
M "exe version=$((Get-Item $exe).VersionInfo.ProductVersion) file=$((Get-Item $exe).VersionInfo.FileVersion)"
M "zcode.cjs sha256=$((Get-FileHash C:\ZCodeApp\resources\glm\zcode.cjs -Algorithm SHA256).Hash)"
$sums = (Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt').Content
$nf = ($sums -split "`n" | Where-Object { $_ -match 'x64\.msi' } | Select-Object -First 1).Trim().Split(' ')[-1]
Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/latest-v22.x/$nf" -OutFile C:\dl\node.msi
$p = Start-Process msiexec.exe -ArgumentList '/i', 'C:\dl\node.msi', '/qn', '/norestart' -PassThru -Wait
M "node msi $nf exit=$($p.ExitCode)"
Invoke-WebRequest -UseBasicParsing -Uri 'https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe' -OutFile C:\dl\py.exe
$p = Start-Process C:\dl\py.exe -ArgumentList '/quiet', 'InstallAllUsers=1', 'PrependPath=1', 'Include_test=0', 'TargetDir=C:\Python312' -PassThru -Wait
$env:Path = "C:\Program Files\nodejs;C:\Python312;C:\Python312\Scripts;" + $env:Path
M "node $(node -v) python $(python --version 2>&1)"
cmd /c "mklink /J C:\ZCodeApp\resources\glm\provider C:\ZCodeApp\resources\config\provider" | Out-Null
$W = 'C:\work'
New-Item -ItemType Directory -Force "$W\tmp", "$W\home", "$W\npm", "C:\zout\e2e" | Out-Null
$tgz = (Get-ChildItem $KIT -Filter 'zn-gate-*.tgz' | Select-Object -First 1).FullName
M "zn-gate tarball $tgz sha256=$((Get-FileHash $tgz -Algorithm SHA256).Hash)"
cmd /c "npm i -g --prefix $W\npm $tgz > C:\zout\npm_install_zn.log 2>&1"
cmd /c "$W\npm\zn-gate.cmd --version > C:\zout\zn_version.txt 2>&1"
M "zn-gate: $((Get-Content C:\zout\zn_version.txt -ErrorAction SilentlyContinue) -join ' ')"
$tr = & tar.exe -xzf "$KIT\market.tgz" -C $W 2>&1 | Out-String
M "market extracted: exit=$LASTEXITCODE $($tr.Trim()) hooks=$(Test-Path $W\market\zn-gate\hooks\hooks.json)"
$env:ZN_STATS = 'off'; $env:PYTHONUTF8 = '1'; $env:PYTHONIOENCODING = 'utf-8'
$env:ZC_CLI = 'C:\ZCodeApp\resources\glm\zcode.cjs'; $env:ZC_APPDIR = 'C:/ZCodeApp'; $env:KIT = $KIT
$env:WORK = 'C:/work'; $env:OUT = 'C:/zout/e2e'
$pr = Start-Process -FilePath 'C:\Python312\python.exe' -ArgumentList @("$KIT\e2epw.py") -WorkingDirectory $W -NoNewWindow -PassThru -RedirectStandardOutput C:\zout\e2e_plugin.log -RedirectStandardError C:\zout\e2e_plugin.err
if (-not $pr.WaitForExit(1500000)) { M 'e2e timeout, killing'; & taskkill.exe /T /F /PID $pr.Id | Out-Null }
M "e2e exit=$($pr.ExitCode)"
Get-Content C:\zout\e2e\summary.txt -ErrorAction SilentlyContinue | ForEach-Object { M "summary: $_" }
Get-Process | Where-Object { $_.Path -like 'C:\ZCodeApp*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Finish
M 'done'
Copy-Item "$O\meta.txt" $env:ZN_OUT -Force
exit 0
