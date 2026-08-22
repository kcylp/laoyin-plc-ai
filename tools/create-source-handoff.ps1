# Build a clean source handoff archive from the current Git commit.
# It never reads or copies .env, databases, runtime logs, licenses, or user data.
[CmdletBinding()]
param(
    [string]$OutputRoot = '',
    [switch]$KeepDirectory
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $OutputRoot) { $OutputRoot = Join-Path $repo 'work\handoff' }
$commit = (& git -C $repo rev-parse HEAD).Trim()
if (-not $commit) { throw 'Unable to resolve Git HEAD' }
$short = $commit.Substring(0, [Math]::Min(12, $commit.Length))
$name = "老殷工控PLC助手_源码交接包_$short"
$stage = Join-Path $OutputRoot $name
$zip = Join-Path $OutputRoot ($name + '.zip')
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# Git archive gives a deterministic, tracked-files-only starting point.
# ZIP avoids legacy tar filename decoding issues on Chinese Windows.
$sourceZip = Join-Path $OutputRoot ($name + '.source.zip')
if (Test-Path -LiteralPath $sourceZip) { Remove-Item -LiteralPath $sourceZip -Force }
& git -C $repo archive --format=zip --output=$sourceZip HEAD
if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($sourceZip, $stage)
Remove-Item -LiteralPath $sourceZip -Force
# Remove tracked build evidence, old ZIPs, and runtime logs. Source and tests stay.
$removeDirs = @(
    '.git', 'node_modules', 'work\logs', 'work\db-backups', 'work\diagnostics',
    'work\browser-verify', 'work\g-ux-verify', 'work\ux-verify',
    'work\green-build\stage', 'work\green-build\verify-extract',
    'work\green-build\verify-extract-final', 'work\green-build\verify-clean-profile',
    'work\green-build\verify-tamper-profile', 'work\screenshots'
)
foreach ($relative in $removeDirs) {
    $target = Join-Path $stage $relative
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
Get-ChildItem -LiteralPath $stage -Recurse -Force -File | Where-Object {
    $_.Name -in @('.env', 'plc_assistant.db', 'license.json') -or
    $_.Extension -in @('.zip', '.db', '.sqlite', '.sqlite3', '.log', '.png', '.jpg', '.jpeg') -or
    $_.Name -like '*.startup.log' -or
    $_.FullName -match '\\work\\green-build\\verify-'
} | Remove-Item -Force

$manifest = [ordered]@{
    format = 'laoyin-source-handoff-v1'
    gitCommit = $commit
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    includes = @('business source', 'tests', 'TIA MCP C# source', 'V21 runtime assets', '.env.example', 'handoff docs', 'diagnose-tia.ps1')
    excludes = @('.env', 'API keys', 'SMTP credentials', 'JWT production secrets', 'database', 'license files', 'logs', 'node_modules', '.git', 'ZIP/build evidence')
}
[System.IO.File]::WriteAllText((Join-Path $stage 'SOURCE_HANDOFF_MANIFEST.json'), ($manifest | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
$readme = @"
老殷工控 PLC 助手源码交接包
Git commit: $commit

使用前请阅读 docs\handoff\源码交接说明.md 和 docs\handoff\TIA_Openness故障排查.md。
本包不含发行方 API Key、SMTP 授权码、JWT 生产密钥、数据库、授权文件或运行日志。
首次开发：npm ci；Copy-Item .env.example .env；npm test；npm start。
"@
[System.IO.File]::WriteAllText((Join-Path $stage 'README_源码交接包.txt'), $readme, [System.Text.UTF8Encoding]::new($false))

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
$size = [Math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1)
Write-Output (ConvertTo-Json ([ordered]@{ commit = $commit; directory = $stage; zip = $zip; sizeMB = $size }) -Compress)
if (-not $KeepDirectory) { Remove-Item -LiteralPath $stage -Recurse -Force }