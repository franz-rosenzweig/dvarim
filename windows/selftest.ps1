# The self-test: the app built in build\Dvarim, with nobody at the keyboard, twice.
#
#  1. On a scratch folder (--folder): the bridge's conformance checks in the page, a
#     change from outside, Quick Entry, the notification area's Today, reminders, and
#     the page's link to the app's own settings.
#  2. In copy mode (--copy) against a real Dvarim server started here on a scratch
#     folder (windows\tools\test-server.mjs, which needs Node): signing in on its page,
#     the token made and kept in Credential Manager, the copy synced both ways, and
#     signing out. Skipped, and said so, without Node.
#
# The Windows workflow runs it after every build; so can you.
#
#   windows\selftest.ps1 [-App build\Dvarim\Dvarim.exe]
#
# It prints each check and leaves with 0 when every check in both runs held.
param([string]$App = "build\Dvarim\Dvarim.exe", [int]$Port = 8421)
$ErrorActionPreference = 'Stop'

$work = Join-Path ([IO.Path]::GetTempPath()) ("dvarim-selftest-" + [guid]::NewGuid().ToString('N'))
$keep = Join-Path (Get-Location) 'build\selftest'
New-Item -ItemType Directory -Force $work, $keep | Out-Null
$exe = (Resolve-Path $App).Path

# Runs the app's self-test once, prints its checks and its log, and gives back its exit code.
function Run-App([string]$Name, [string[]]$Arguments, [string]$Data) {
    $results = Join-Path $work "$Name.json"
    $process = Start-Process -FilePath $exe -ArgumentList ($Arguments + @('--data', "`"$Data`"", '--out', "`"$results`"")) -PassThru
    $null = $process.Handle          # or the exit code is lost once it ends
    if (-not $process.WaitForExit(240000)) {
        $process.Kill()
        Write-Host "the $Name self-test didn't finish in four minutes"
        $code = 2
    } else {
        $code = $process.ExitCode
    }
    Write-Host "=== $Name"
    if (Test-Path $results) {
        $report = Get-Content $results -Raw -Encoding utf8 | ConvertFrom-Json
        foreach ($check in $report.checks) {
            $mark = if ($check.ok) { 'ok  ' } else { 'FAIL' }
            if ($check.ok -or -not $check.detail) { Write-Host "$mark  $($check.name)" } else { Write-Host "$mark  $($check.name)  ($($check.detail))" }
        }
        Copy-Item $results $keep
    } else {
        Write-Host "no results were written"
    }
    $log = Join-Path $Data 'dvarim.log'
    if (Test-Path $log) {
        Write-Host "--- dvarim.log"
        Get-Content $log -Encoding utf8 | ForEach-Object { Write-Host $_ }
        Copy-Item $log (Join-Path $keep "$Name.log")
    }
    return $code
}

# ---- 1. on a folder
$folder = Join-Path $work 'Tasks'
New-Item -ItemType Directory -Force $folder | Out-Null
$folderCode = Run-App 'folder' @('--selftest', '--folder', "`"$folder`"") (Join-Path $work 'Data-folder')

# ---- 2. the copy, against a server on this PC
$copyCode = 0
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "=== copy"
    Write-Host "skip  no Node here to run a Dvarim server on"
} else {
    $serverRoot = Join-Path $work 'Server'
    New-Item -ItemType Directory -Force $serverRoot | Out-Null
    [IO.File]::WriteAllText((Join-Path $serverRoot 'Inbox.md'), "- [ ] Seeded on the server`n", (New-Object Text.UTF8Encoding($false)))
    $env:DVARIM_ROOT = $serverRoot
    $env:PORT = "$Port"
    $env:HOST = '127.0.0.1'
    $env:DVARIM_SELFTEST_PASSWORD = [guid]::NewGuid().ToString('N')     # a password for this run, and nothing else
    $serverLog = Join-Path $work 'server.log'
    $server = Start-Process -FilePath $node.Source -ArgumentList "`"$(Join-Path $PSScriptRoot 'tools\test-server.mjs')`"" -PassThru -NoNewWindow `
        -RedirectStandardError $serverLog -RedirectStandardOutput (Join-Path $work 'server.out')
    $up = $false
    for ($i = 0; $i -lt 60 -and -not $up; $i++) {
        Start-Sleep -Milliseconds 500
        try { $up = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/health" -TimeoutSec 2).Content -match '"ok"' } catch { }
    }
    if (-not $up) {
        Write-Host "=== copy"
        Write-Host "FAIL  the Dvarim server didn't start"
        $copyCode = 3
    } else {
        $copyCode = Run-App 'copy' @('--selftest', '--copy', '--server', "http://127.0.0.1:$Port") (Join-Path $work 'Data-copy')
    }
    if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    Remove-Item Env:DVARIM_SELFTEST_PASSWORD
    if (Test-Path $serverLog) {
        Write-Host "--- the server"
        Get-Content $serverLog | ForEach-Object { Write-Host $_ }
        Copy-Item $serverLog $keep
    }
}

if ($folderCode -ne 0) { exit $folderCode }
exit $copyCode
