$ErrorActionPreference = 'Stop'
$gb = 'F:\工控软件\老殷工控PLC助手\work\green-build'
$repo = 'F:\工控软件\老殷工控PLC助手'
$zip = Join-Path $gb '老殷工控PLC助手_绿色免安装版_v1.0.zip'
$extract = Join-Path $gb 'verify-extract-final'
$evidence = Join-Path $gb 'verify-final-evidence.txt'
$lines = New-Object System.Collections.Generic.List[string]
function Log([string]$text) {
    Write-Output $text
    [void]$lines.Add($text)
}
function Finish([int]$code) {
    [IO.File]::WriteAllLines($evidence, $lines, [Text.UTF8Encoding]::new($true))
    exit $code
}

Log ('===== Green package final verification ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' =====')

Log '--- 1. Build ---'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $gb 'build-green.ps1') |
    ForEach-Object { Log ([string]$_) }
if (-not (Test-Path -LiteralPath $zip)) {
    Log 'FAIL: package ZIP was not produced'
    Finish 1
}

Log '--- 2. Extract and purity ---'
if (Test-Path -LiteralPath $extract) {
    Remove-Item -LiteralPath $extract -Recurse -Force
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($zip, $extract)
$root = Join-Path $extract '老殷工控PLC助手'
$required = @(
    '老殷工控PLC助手.exe',
    'runtime\laoyin-server.exe',
    'app\login.html',
    'app\web\app.js',
    'app\engine\src\EngineerYin.psm1',
    'app\engine\src\YinImportCore.ps1',
    'app\engine\tia-mcp\runtime\v21\TiaMcpServer.exe',
    'README_请先看.txt'
)
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $root $_)) })
$badDirs = @(Get-ChildItem -LiteralPath $root -Recurse -Force -Directory | Where-Object {
    $_.Name -in @('.git', 'node_modules', 'test', 'tests')
})
$badFiles = @(Get-ChildItem -LiteralPath $root -Recurse -Force -File | Where-Object {
    $_.Name -in @('.env', 'server.js', 'license.js', 'sea-entry.js', 'package.json', 'package-lock.json') -or
    $_.Name -like '*.test.js' -or $_.Name -like 'probe-*' -or
    $_.Name -like 'stress-*' -or $_.Name -like 'e2e-*' -or $_.Name -like 'smoke-*'
})
$runtimeNode = Test-Path -LiteralPath (Join-Path $root 'runtime\node.exe')
$emptyLogs = (Get-ChildItem -LiteralPath (Join-Path $root 'app\work\logs') -Force -File | Measure-Object).Count -eq 0
$emptyBackups = (Get-ChildItem -LiteralPath (Join-Path $root 'app\work\db-backups') -Force -File | Measure-Object).Count -eq 0
Log ('ZIP bytes: ' + (Get-Item -LiteralPath $zip).Length)
Log ('Required entries missing: ' + $missing.Count)
Log ('Forbidden directories: ' + $badDirs.Count)
Log ('Forbidden files: ' + $badFiles.Count)
Log ('Runtime Node bundled: ' + $runtimeNode + ' (expect False)')
Log ('Fresh logs directory: ' + $emptyLogs)
Log ('Fresh DB backup directory: ' + $emptyBackups)
if ($missing.Count -gt 0) { $missing | ForEach-Object { Log ('  missing: ' + $_) } }
if ($badDirs.Count -gt 0) { $badDirs | ForEach-Object { Log ('  bad dir: ' + $_.FullName) } }
if ($badFiles.Count -gt 0) { $badFiles | ForEach-Object { Log ('  bad file: ' + $_.FullName) } }
if ($missing.Count -gt 0 -or $badDirs.Count -gt 0 -or $badFiles.Count -gt 0 -or
    $runtimeNode -or -not $emptyLogs -or -not $emptyBackups) {
    Log 'FAIL: package purity/structure gate'
    Finish 1
}
Log 'PASS: package purity/structure gate'

Log '--- 3. Clean-profile launcher boot ---'
$portOwner = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($portOwner) {
    Log 'SKIP: port 3000 is already occupied; no existing process was stopped'
} else {
    $profile = Join-Path $gb 'verify-clean-profile'
    if (Test-Path -LiteralPath $profile) { Remove-Item -LiteralPath $profile -Recurse -Force }
    [IO.Directory]::CreateDirectory($profile) | Out-Null
    $oldLocalAppData = $env:LOCALAPPDATA
    $env:LOCALAPPDATA = $profile
    $launcher = $null
    try {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $launcher = Start-Process -FilePath (Join-Path $root '老殷工控PLC助手.exe') -WorkingDirectory $root -PassThru
        $license = $null
        $ready = $false
        for ($i = 0; $i -lt 120; $i++) {
            Start-Sleep -Milliseconds 250
            try {
                $license = Invoke-RestMethod -Uri 'http://localhost:3000/api/license' -TimeoutSec 1
                if ($license.ok -eq $true) { $ready = $true; break }
            } catch { }
        }
        $sw.Stop()
        Log ('Launcher PID: ' + $launcher.Id)
        Log ('Cold start ms: ' + $sw.ElapsedMilliseconds)
        Log ('License API ok: ' + $ready)
        if ($license) { Log ('Trial remaining days: ' + $license.remainingDays) }
        if (-not $ready) {
            Log 'FAIL: launcher did not expose /api/license within 30 seconds'
            Finish 1
        }
        $login = Invoke-WebRequest -Uri 'http://localhost:3000/login.html' -UseBasicParsing -TimeoutSec 3
        Log ('Login HTTP: ' + $login.StatusCode)
        $profileLicenseDir = Join-Path $profile '老殷工控PLC助手'
        Log ('License file created in user profile: ' + (Test-Path (Join-Path $profileLicenseDir 'license.json')))
        Log ('Trial marker created in user profile: ' + (Test-Path (Join-Path $profileLicenseDir 'trial.marker')))
        Log 'PASS: clean-profile launcher boot'
    } finally {
        $env:LOCALAPPDATA = $oldLocalAppData
        if ($launcher -and -not $launcher.HasExited) {
            & taskkill.exe /PID $launcher.Id /T /F | Out-Null
        }
        Start-Sleep -Seconds 2
    }
}

Log '--- 4. SEA tamper refusal ---'
$tamperProfile = Join-Path $gb 'verify-tamper-profile'
if (Test-Path -LiteralPath $tamperProfile) { Remove-Item -LiteralPath $tamperProfile -Recurse -Force }
[IO.Directory]::CreateDirectory((Join-Path $tamperProfile '老殷工控PLC助手')) | Out-Null
$tamperLicense = Join-Path $tamperProfile '老殷工控PLC助手\license.json'
$tamperMarker = Join-Path $tamperProfile '老殷工控PLC助手\trial.marker'
$tamperRecord = '{"startedAt":"2026-08-07T00:00:00.000Z","machine":"tampered","version":1,"signature":"tampered"}'
[IO.File]::WriteAllText($tamperLicense, $tamperRecord, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($tamperMarker, $tamperRecord, [Text.UTF8Encoding]::new($false))
$oldLocalAppData = $env:LOCALAPPDATA
$env:LOCALAPPDATA = $tamperProfile
$env:APP_ROOT = Join-Path $root 'app'
$env:DB_PATH = Join-Path $tamperProfile 'plc_assistant.db'
$env:PORT = '33119'
$env:TIA_PREWARM = '0'
$tamper = Start-Process -FilePath (Join-Path $root 'runtime\laoyin-server.exe') -WorkingDirectory (Join-Path $root 'app') -PassThru -Wait -WindowStyle Hidden
$env:LOCALAPPDATA = $oldLocalAppData
Remove-Item Env:APP_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:DB_PATH -ErrorAction SilentlyContinue
Remove-Item Env:PORT -ErrorAction SilentlyContinue
Remove-Item Env:TIA_PREWARM -ErrorAction SilentlyContinue
Log ('Tampered license exit code: ' + $tamper.ExitCode + ' (expect 78)')
if ($tamper.ExitCode -ne 78) {
    Log 'FAIL: tampered license did not refuse startup'
    Finish 1
}
Log 'PASS: tampered license refusal'

Log '--- 5. TIA capability availability ---'
$tiaExe = Join-Path $root 'app\engine\tia-mcp\runtime\v21\TiaMcpServer.exe'
$tiaInstalled = Test-Path -LiteralPath 'C:\Program Files\Siemens\Automation\Portal V21'
Log ('TiaMcpServer.exe present in package: ' + (Test-Path -LiteralPath $tiaExe))
Log ('TIA Portal V21 detected: ' + $tiaInstalled)
if (-not $tiaInstalled) {
    Log 'LIMITATION: no local TIA Portal installation was detected; live Connect/tree/tag-table/hardware/write-compile journey was not executed.'
}

Log '===== VERIFICATION FINISHED ====='
Finish 0
