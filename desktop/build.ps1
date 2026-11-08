# Builds the Windows app:  powershell -ExecutionPolicy Bypass -File desktop\build.ps1
#   dist\Aether\                         the app folder (what both downloads contain)
#   dist\Aether-<ver>-portable.zip       unzip anywhere, run Aether.exe
#   dist\Aether-Setup-<ver>.exe          installer (needs Inno Setup 6: winget install JRSoftware.InnoSetup)
# The models are taken from %USERPROFILE%\.aether\models (or $env:AETHER_MODELS).
param([switch]$NoInstaller, [switch]$NoZip)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot)
$py = ".venv\Scripts\python.exe"

& $py -m pip install -q -r requirements.txt -r desktop\requirements.txt
if ($LASTEXITCODE) { throw "pip install failed" }
$ver = (& $py -c "import engine; print(engine.__version__)").Trim()
Write-Host "Building Aether $ver"

foreach ($d in "build", "dist\Aether") { if (Test-Path $d) { Remove-Item $d -Recurse -Force } }
& $py -m PyInstaller desktop\aether.spec --noconfirm --clean --distpath dist --workpath build --log-level WARN
if ($LASTEXITCODE) { throw "PyInstaller failed" }

if (-not $NoZip) {
  $zip = "dist\Aether-$ver-portable.zip"
  if (Test-Path $zip) { Remove-Item $zip }
  tar.exe -a -c -f $zip -C dist Aether
  if ($LASTEXITCODE) { throw "zip failed" }
}

if (-not $NoInstaller) {
  $iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $iscc) { throw "Inno Setup 6 not found: winget install JRSoftware.InnoSetup" }
  $env:AETHER_VERSION = $ver
  & $iscc /Q desktop\installer.iss
  if ($LASTEXITCODE) { throw "Inno Setup failed" }
}
Get-ChildItem dist -File | Select-Object Name, @{n = "MB"; e = { [math]::Round($_.Length / 1MB) } } | Format-Table -AutoSize
