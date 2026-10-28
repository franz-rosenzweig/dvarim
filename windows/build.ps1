# Builds Dvarim for Windows on this PC, as the Windows workflow does on GitHub's:
# the web app, the tests, the app, the self-test, and with Inno Setup installed the installer.
# Needs Node 22, the .NET 10 SDK, and Python for the tests' check against tools\bridge_sim.py.
#
#   windows\build.ps1 [-Version 0.1.0] [-SkipSelfTest]
#
# The app ends up in build\Dvarim (it runs from there as it is); the installer in build\out.
param([string]$Version = "", [switch]$SkipSelfTest)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot)

if (-not $Version) { $Version = ([xml](Get-Content windows\Dvarim\Dvarim.csproj)).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1 }

Push-Location frontend
npm ci; if ($LASTEXITCODE) { throw "npm ci failed" }
npx vite build; if ($LASTEXITCODE) { throw "the web app didn't build" }
Pop-Location

dotnet run --project windows\Tests -c Release -- --repo "$PWD"
if ($LASTEXITCODE) { throw "the tests failed" }

powershell -NoProfile -File windows\tools\make-icon.ps1
Remove-Item -Recurse -Force build\Dvarim -ErrorAction SilentlyContinue
dotnet publish windows\Dvarim\Dvarim.csproj -c Release -r win-x64 -p:Platform=x64 -p:Version=$Version -o build\Dvarim
if ($LASTEXITCODE) { throw "the app didn't build" }

if (-not $SkipSelfTest) {
    & windows\selftest.ps1 -App build\Dvarim\Dvarim.exe
    if ($LASTEXITCODE) { throw "the self-test failed" }
}

$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($iscc) {
    & $iscc /Q "/DVersion=$Version" "/DSource=$PWD\build\Dvarim" windows\installer.iss
    if ($LASTEXITCODE) { throw "the installer didn't build" }
    "made build\out\Dvarim-$Version-Setup.exe"
} else {
    "no Inno Setup: build\Dvarim is the app, without an installer"
}
