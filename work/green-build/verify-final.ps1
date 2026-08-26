$ErrorActionPreference = 'Stop'
$gb = $PSScriptRoot
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$zip = Join-Path $gb 'LaoyinPLC-Green-v1.0.2.zip'
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

function Get-PortableRelativePath([string]$basePath, [string]$targetPath) {
    $baseFull = [System.IO.Path]::GetFullPath($basePath)
    if (-not $baseFull.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
        $baseFull += [System.IO.Path]::DirectorySeparatorChar
    }
    $targetFull = [System.IO.Path]::GetFullPath($targetPath)
    $baseUri = [Uri]$baseFull
    $targetUri = [Uri]$targetFull
    return [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
}

function Test-AllowedZipPath([string]$name) {
    $p = $name.Replace('\', '/').TrimStart('/')
    if ($p -eq '老殷工控PLC助手/') { return $true }
    if ($p.EndsWith('/')) {
        foreach ($prefix in @(
            '老殷工控PLC助手/app/',
            '老殷工控PLC助手/app/engine/',
            '老殷工控PLC助手/app/engine/src/',
            '老殷工控PLC助手/app/engine/schemas/',
            '老殷工控PLC助手/app/engine/tia-mcp/',
            '老殷工控PLC助手/app/engine/tia-mcp/manifest/',
            '老殷工控PLC助手/app/engine/tia-mcp/runtime/',
            '老殷工控PLC助手/app/engine/tia-mcp/runtime/v',
            '老殷工控PLC助手/app/tools/',
            '老殷工控PLC助手/app/web/',
            '老殷工控PLC助手/app/web/css/',
            '老殷工控PLC助手/app/work/',
            '老殷工控PLC助手/app/work/db-backups/',
            '老殷工控PLC助手/app/work/logs/',
            '老殷工控PLC助手/runtime/',
            '老殷工控PLC助手/说明文档/'
        )) { if ($p.StartsWith($prefix)) { return $true } }
        return $false
    }

    $exact = @(
        '老殷工控PLC助手/老殷工控PLC助手.exe',
        '老殷工控PLC助手/老殷工控PLC助手更新器.exe',
        '老殷工控PLC助手/README_请先看.txt',
        '老殷工控PLC助手/runtime/laoyin-server.exe',
        '老殷工控PLC助手/app/index.html',
        '老殷工控PLC助手/app/login.html',
        '老殷工控PLC助手/app/settings.html',
        '老殷工控PLC助手/app/admin.html',
        '老殷工控PLC助手/app/env-check.html',
        '老殷工控PLC助手/app/upgrade.html',
        '老殷工控PLC助手/app/style.css',
        '老殷工控PLC助手/app/login.css',
        '老殷工控PLC助手/app/admin.css',
        '老殷工控PLC助手/app/operations.css',
        '老殷工控PLC助手/app/tia.css',
        '老殷工控PLC助手/app/upgrade.css',
        '老殷工控PLC助手/app/ai-models.js',
        '老殷工控PLC助手/app/plc-language.js',
        '老殷工控PLC助手/app/tia-confirmation.js',
        '老殷工控PLC助手/app/tia-import-state.js',
        '老殷工控PLC助手/app/login.js',
        '老殷工控PLC助手/app/admin.js',
        '老殷工控PLC助手/app/upgrade.js',
        '老殷工控PLC助手/app/tools/diagnose-tia.ps1',
        '老殷工控PLC助手/app/engine/tia-mcp/manifest/tools-list.json',
        '老殷工控PLC助手/说明文档/绿色版用户手册.md',
        '老殷工控PLC助手/说明文档/绿色版用户手册.pdf',
        '老殷工控PLC助手/说明文档/绿色版用户手册.docx'
    )
    if ($exact -contains $p) { return $true }
    if ($p -match '^老殷工控PLC助手/app/web/[^/]+\.js$') { return $true }
    if ($p -match '^老殷工控PLC助手/app/web/css/[^/]+\.css$') { return $true }
    if ($p -match '^老殷工控PLC助手/app/engine/src/(?!test_validate\.ps1$)[^/]+\.(ps1|psm1|xsd)$') { return $true }
    if ($p -match '^老殷工控PLC助手/app/engine/schemas/[^/]+\.xsd$') { return $true }
    if ($p -match '^老殷工控PLC助手/app/engine/tia-mcp/runtime/v[^/]+/.+') { return $true }
    return $false
}

function Get-PackageContentFindings([string]$rootDir) {
    $scanExtensions = @('.txt','.html','.css','.js','.json','.ps1','.psm1','.xsd','.md','.xml','.config')
    $rules = @(
        @{ Name = 'ADMIN_KEY'; Pattern = 'ADMIN_KEY' },
        @{ Name = 'JWT_SECRET'; Pattern = 'JWT_SECRET' },
        @{ Name = 'adminKey='; Pattern = 'adminKey=' },
        @{ Name = 'decrypt('; Pattern = 'decrypt\(' },
        @{ Name = 'OpenAI-style secret'; Pattern = 'sk-[A-Za-z0-9_-]{16,}' },
        @{ Name = 'QQ email'; Pattern = '@qq\.com' },
        @{ Name = 'F drive absolute path'; Pattern = 'F:\\' },
        @{ Name = 'Windows user path'; Pattern = 'C:\\Users' }
    )
    $findings = New-Object System.Collections.Generic.List[string]
    Get-ChildItem -LiteralPath $rootDir -Recurse -Force -File | Where-Object { $scanExtensions -contains $_.Extension } | ForEach-Object {
        $text = [IO.File]::ReadAllText($_.FullName, [Text.Encoding]::UTF8)
        foreach ($rule in $rules) {
            if ($text -match $rule.Pattern) {
                $rel = Get-PortableRelativePath $rootDir $_.FullName
                [void]$findings.Add($rule.Name + ' in ' + $rel)
            }
        }
    }
    return @($findings)
}

Log ('===== Green package final verification ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' =====')

Log '--- 1. Build ---'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $gb 'build-green.ps1') |
    ForEach-Object { Log ([string]$_) }
if (-not (Test-Path -LiteralPath $zip)) {
    Log 'FAIL: package ZIP was not produced'
    Finish 1
}

Log '--- 2. Extract and whitelist purity ---'
if (Test-Path -LiteralPath $extract) {
    Remove-Item -LiteralPath $extract -Recurse -Force
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
    $zipEntries = @($archive.Entries)
    $badEntries = @($zipEntries | Where-Object { -not (Test-AllowedZipPath $_.FullName) })
} finally {
    $archive.Dispose()
}
[IO.Compression.ZipFile]::ExtractToDirectory($zip, $extract)
$root = Join-Path $extract '老殷工控PLC助手'
$required = @(
    '老殷工控PLC助手.exe',
    '老殷工控PLC助手更新器.exe',
    'runtime\laoyin-server.exe',
    'app\login.html',
    'app\admin.html',
    'app\web\app.js',
    'app\engine\src\EngineerYin.psm1',
    'app\engine\src\YinImportCore.ps1',
    'app\engine\schemas\SW.PlcBlocks.LADFBD_v5.xsd',
    'app\tools\diagnose-tia.ps1',
    'app\engine\tia-mcp\manifest\tools-list.json',
    'app\engine\tia-mcp\runtime\v21\TiaMcpServer.exe',
    'README_请先看.txt'
)
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $root $_)) })
$contentFindings = @(Get-PackageContentFindings $root)
$runtimeNode = Test-Path -LiteralPath (Join-Path $root 'runtime\node.exe')
$emptyLogs = (Get-ChildItem -LiteralPath (Join-Path $root 'app\work\logs') -Force -File | Measure-Object).Count -eq 0
$emptyBackups = (Get-ChildItem -LiteralPath (Join-Path $root 'app\work\db-backups') -Force -File | Measure-Object).Count -eq 0
$updaterPresent = Test-Path -LiteralPath (Join-Path $root '老殷工控PLC助手更新器.exe')
Log ('ZIP entries: ' + $zipEntries.Count)
Log ('ZIP bytes: ' + (Get-Item -LiteralPath $zip).Length)
Log ('Non-whitelisted entries: ' + $badEntries.Count)
Log ('Required entries missing: ' + $missing.Count)
Log ('Sensitive content findings: ' + $contentFindings.Count)
Log ('Runtime Node bundled: ' + $runtimeNode + ' (expect False)')
Log ('Updater executable present: ' + $updaterPresent)
Log ('Fresh logs directory: ' + $emptyLogs)
Log ('Fresh DB backup directory: ' + $emptyBackups)
if ($badEntries.Count -gt 0) { $badEntries | Select-Object -First 50 | ForEach-Object { Log ('  non-whitelist: ' + $_.FullName) } }
if ($missing.Count -gt 0) { $missing | ForEach-Object { Log ('  missing: ' + $_) } }
if ($contentFindings.Count -gt 0) { $contentFindings | Select-Object -First 50 | ForEach-Object { Log ('  sensitive: ' + $_) } }
if ($badEntries.Count -gt 0 -or $missing.Count -gt 0 -or $contentFindings.Count -gt 0 -or
    $runtimeNode -or -not $emptyLogs -or -not $emptyBackups -or -not $updaterPresent) {
    Log 'FAIL: package whitelist/content gate'
    Finish 1
}
Log 'PASS: package whitelist/content gate'

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
                $license = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/license' -TimeoutSec 1
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
        $loginPage = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/login.html' -UseBasicParsing -TimeoutSec 3
        Log ('Login page HTTP: ' + $loginPage.StatusCode)
        $testUsername = 'verify_' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
        $testPassword = 'Verify-' + [Guid]::NewGuid().ToString('N')
        $registerBody = @{ username = $testUsername; password = $testPassword; email = '' } | ConvertTo-Json -Compress
        $registered = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/register' -Method Post -ContentType 'application/json' -Body $registerBody -TimeoutSec 10
        if ($registered.success -ne $true) {
            Log 'FAIL: real registration did not succeed'
            Finish 1
        }
        $loginBody = @{ username = $testUsername; password = $testPassword } | ConvertTo-Json -Compress
        $login = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/login' -Method Post -ContentType 'application/json' -Body $loginBody -TimeoutSec 10
        if ($login.success -ne $true -or [string]::IsNullOrWhiteSpace([string]$login.token) -or @(([string]$login.token).Split('.')).Count -ne 3) {
            Log 'FAIL: real login did not return a three-part JWT'
            Finish 1
        }
        Log 'Real register/login JWT: PASS'
        $profileLicenseDir = Join-Path $profile '老殷工控PLC助手'
        Log ('License file created in user profile: ' + (Test-Path (Join-Path $profileLicenseDir 'license.json')))
        Log ('Trial marker created in user profile: ' + (Test-Path (Join-Path $profileLicenseDir 'trial.marker')))
        $secretsCreated = Test-Path (Join-Path $profileLicenseDir 'secrets.json')
        Log ('DPAPI secrets file created in user profile: ' + $secretsCreated)
        if (-not $secretsCreated) {
            Log 'FAIL: DPAPI secrets file was not created in the clean user profile'
            Finish 1
        }
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

Log '--- 5. Update contract and remote publication inputs ---'
$manifestPath = Join-Path $repo 'update-manifest.json'
$manifestPresent = Test-Path -LiteralPath $manifestPath
Log ('Update manifest present: ' + $manifestPresent)
if (-not $manifestPresent) {
    Log 'FAIL: update manifest missing'
    Finish 1
}
$manifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
$manifestZip = [IO.Path]::GetFileName([Uri]$manifest.packageUrl)
$zipHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
Log ('Manifest package filename: ' + $manifestZip)
Log ('Manifest size matches: ' + ([int64]$manifest.sizeBytes -eq (Get-Item -LiteralPath $zip).Length))
Log ('Manifest SHA256 matches: ' + ($manifest.sha256.ToLowerInvariant() -eq $zipHash))
if ($manifestZip -ne (Split-Path -Leaf $zip) -or [int64]$manifest.sizeBytes -ne (Get-Item -LiteralPath $zip).Length -or $manifest.sha256.ToLowerInvariant() -ne $zipHash) {
    Log 'FAIL: update manifest does not match package'
    Finish 1
}
if ([string]$manifest.packageUrl -notmatch '^https://github\.com/kcylp/laoyin-plc-ai/releases/download/v\d+\.\d+\.\d+/.+\.zip$') {
    Log 'FAIL: update manifest package URL is not the trusted GitHub Release URL'
    Finish 1
}
if ([string]$manifest.version -ne '1.0.2' -or [string]$manifest.minLauncherVersion -ne '1.0.2') {
    Log 'FAIL: update manifest version contract'
    Finish 1
}
Log 'Manifest package URL: trusted GitHub Release HTTPS'
Log 'Manifest version: 1.0.2'

Log '--- 6. Runtime data paths ---'
$loggerSrc = [IO.File]::ReadAllText((Join-Path $repo 'lib\logger.js'), [Text.Encoding]::UTF8)
$backupSrc = [IO.File]::ReadAllText((Join-Path $repo 'lib\db-backup.js'), [Text.Encoding]::UTF8)
$loggerUsesLocalAppData = $loggerSrc -match 'LOCALAPPDATA' -and $loggerSrc -match 'MAX_LOG_BYTES\s*=\s*10 \* 1024 \* 1024' -and $loggerSrc -match 'MAX_ROTATED_LOGS\s*=\s*5'
$backupUsesLocalAppData = $backupSrc -match 'LOCALAPPDATA' -and $backupSrc -match 'db-backups'
Log ('Logger uses LOCALAPPDATA and 10MB/5 rotation: ' + $loggerUsesLocalAppData)
Log ('DB backup uses LOCALAPPDATA: ' + $backupUsesLocalAppData)
if (-not $loggerUsesLocalAppData -or -not $backupUsesLocalAppData) {
    Log 'FAIL: runtime logs/backups are not configured for user profile storage'
    Finish 1
}

Log '--- 7. TIA capability availability ---'
$tiaExe = Join-Path $root 'app\engine\tia-mcp\runtime\v21\TiaMcpServer.exe'
$tiaInstalled = Test-Path -LiteralPath 'C:\Program Files\Siemens\Automation\Portal V21'
Log ('TiaMcpServer.exe present in package: ' + (Test-Path -LiteralPath $tiaExe))
Log ('TIA Portal V21 detected: ' + $tiaInstalled)
if (-not $tiaInstalled) {
    Log 'LIMITATION: no local TIA Portal installation was detected; live Connect/tree/tag-table/hardware/write-compile journey was not executed.'
}

Log '===== VERIFICATION FINISHED ====='
Finish 0
