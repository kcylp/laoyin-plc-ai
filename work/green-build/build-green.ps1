# Green portable build: launcher EXE + Node SEA backend + external UI/TIA assets.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$root = Join-Path $repo 'work\green-build'
$tools = Join-Path $repo 'work\sea-toolchain'
$stageRoot = Join-Path $root 'stage'
$stage = Join-Path $stageRoot '老殷工控PLC助手'
$ver = 'v1.0.2'
$zip = Join-Path $root ("LaoyinPLC-Green-" + $ver + ".zip")
$node = 'D:\DevTools\nodejs\node.exe'
$signtool = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
foreach ($d in @('app','app\work\logs','app\work\db-backups','app\tools','runtime','说明文档\screenshots')) {
    [System.IO.Directory]::CreateDirectory((Join-Path $stage $d)) | Out-Null
}

# 1. Bundle backend and create SEA executable.

# Webpack inspects package.json as a directory description file. Keep the
# historical UTF-8 BOM in the repository, but remove it only during this
# local build and restore the exact original bytes even when the build fails.
$packageJsonPath = Join-Path $repo 'package.json'
$packageJsonBytes = [System.IO.File]::ReadAllBytes($packageJsonPath)
$packageJsonHasBom = $packageJsonBytes.Length -ge 3 -and $packageJsonBytes[0] -eq 0xEF -and $packageJsonBytes[1] -eq 0xBB -and $packageJsonBytes[2] -eq 0xBF
if ($packageJsonHasBom) { [System.IO.File]::WriteAllBytes($packageJsonPath, $packageJsonBytes[3..($packageJsonBytes.Length - 1)]) }
try {
    Push-Location $tools
    try {
        & (Join-Path $tools 'node_modules\.bin\webpack.cmd') --config (Join-Path $tools 'webpack.config.js')
        if ($LASTEXITCODE -ne 0) { throw 'webpack failed' }
        & $node --experimental-sea-config (Join-Path $tools 'sea-config.json')
        if ($LASTEXITCODE -ne 0) { throw 'SEA blob failed' }
        $serverExe = Join-Path $stage 'runtime\laoyin-server.exe'
        Copy-Item -LiteralPath $node -Destination $serverExe
        & $signtool remove /s $serverExe | Out-Null
        & (Join-Path $tools 'node_modules\.bin\postject.cmd') $serverExe NODE_SEA_BLOB (Join-Path $tools 'sea-prep.blob') --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite
        if ($LASTEXITCODE -ne 0) { throw 'SEA injection failed' }
    } finally {
        Pop-Location
    }
} finally {
    if ($packageJsonHasBom) { [System.IO.File]::WriteAllBytes($packageJsonPath, $packageJsonBytes) }
}


# 2. External assets required by browser and TIA Openness.
$appDir = Join-Path $stage 'app'
$frontendJs = @('ai-models.js','plc-language.js','tia-confirmation.js','tia-import-state.js','login.js','admin.js','upgrade.js')
foreach ($f in $frontendJs) { Copy-Item -LiteralPath (Join-Path $repo $f) -Destination $appDir }
Get-ChildItem -LiteralPath $repo -File -Filter '*.html' | Copy-Item -Destination $appDir
Get-ChildItem -LiteralPath $repo -File -Filter '*.css' | Copy-Item -Destination $appDir
Copy-Item -LiteralPath (Join-Path $repo 'web') -Destination $appDir -Recurse
Copy-Item -LiteralPath (Join-Path $repo 'engine') -Destination $appDir -Recurse
Copy-Item -LiteralPath (Join-Path $repo 'tools\diagnose-tia.ps1') -Destination (Join-Path $appDir 'tools')
# Never ship MCP startup logs or other runtime log files.
Get-ChildItem -LiteralPath $appDir -Recurse -Force -File |
    Where-Object { $_.Extension -eq '.log' -or $_.Name -like '*.startup.log' } |
    Remove-Item -Force

# The runtime needs the external PowerShell/TIA assets, but customer packages
# must not carry the repository's test tree or C# development sources.
$engineTests = Join-Path $appDir 'engine\tests'
if (Test-Path -LiteralPath $engineTests) {
    Remove-Item -LiteralPath $engineTests -Recurse -Force
}
$mcpSource = Join-Path $appDir 'engine\tia-mcp\tools\tiaportal-mcp\src'
if (Test-Path -LiteralPath $mcpSource) {
    Remove-Item -LiteralPath $mcpSource -Recurse -Force
}
Get-ChildItem -LiteralPath (Join-Path $appDir 'engine') -Recurse -Force -File |
    Where-Object {
        $_.Name -match '^(probe|stress|smoke|e2e)-' -or
        $_.Name -match '\.test\.' -or
        $_.Name -in @('test_validate.ps1')
    } |
    Remove-Item -Force

# 3. Compile the tray launcher.
$launcher = Join-Path $stage '老殷工控PLC助手.exe'
& $csc /nologo /target:winexe /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /out:$launcher (Join-Path $root 'launcher.cs')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcher)) { throw 'launcher compile failed' }
$updater = Join-Path $stage '老殷工控PLC助手更新器.exe'
& $csc /nologo /target:winexe /optimize+ /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /out:$updater (Join-Path $root 'updater.cs')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $updater)) { throw 'updater compile failed' }

# 4. Customer documentation.
$enc = [System.Text.UTF8Encoding]::new($false)
$docsDir = Join-Path $stage '说明文档'
[System.IO.File]::WriteAllText((Join-Path $stage 'README_请先看.txt'), @"
【老殷工控 PLC 助手 - 绿色免安装版 v1.0.2】

使用方法
1. 将 ZIP 完整解压到任意本地文件夹，不要在压缩包内直接运行。
2. 双击“老殷工控PLC助手.exe”。
3. 程序通过本机健康检查后自动打开浏览器：http://localhost:3000
4. 首次登录后，在“设置”里填写客户自己的 API 地址、API Key 和模型。
5. 退出软件：右击任务栏通知区域里的“老殷工控PLC助手”图标，选择“退出”。

授权与数据
- 首次启动生成 60 天离线试用授权。
- 授权、数据库保存在：%LOCALAPPDATA%\老殷工控PLC助手
- 删除或修改授权文件会导致授权失效，不会自动重置试用期。
- API Key 加密存储；复制程序目录不会复制客户 Key。

目录结构
- 老殷工控PLC助手.exe：启动器与托盘管理
- runtime\laoyin-server.exe：SEA 单文件后端（不需要客户安装 Node.js）
- 老殷工控PLC助手更新器.exe：安全更新与失败回滚
- app\web、HTML、CSS：浏览器界面资产
- app\engine：TIA Openness、MCP 与 PowerShell 引擎（必须保持真实路径）
- app\tools\diagnose-tia.ps1：客户环境诊断脚本
- app\work：运行日志与数据库备份目录
- 说明文档：用户手册与验收截图

注意
- 只支持 Windows 10/11 64 位。
- 端口 3000 被占用时程序会中文提示，不会静默失败。
- TIA 功能需要本机安装兼容的 Siemens TIA Portal/Openness 环境。
"@, $enc)

$handoffDocs = Join-Path $repo 'docs\handoff'
if (Test-Path -LiteralPath $handoffDocs) {
    Get-ChildItem -LiteralPath $handoffDocs -File -Filter '*.md' | Copy-Item -Destination $docsDir
}$manual = Join-Path $repo 'docs\green-edition\绿色版用户手册.md'
if (Test-Path -LiteralPath $manual) { Copy-Item -LiteralPath $manual -Destination $docsDir }
foreach ($ext in @('docx','pdf')) {
    $doc = Join-Path $repo ("docs\green-edition\绿色版用户手册." + $ext)
    if (Test-Path -LiteralPath $doc) { Copy-Item -LiteralPath $doc -Destination $docsDir }
}
$shots = Join-Path $repo 'work\screenshots'
if (Test-Path -LiteralPath $shots) {
    Get-ChildItem -LiteralPath $shots -File -Filter '*.png' | Copy-Item -Destination (Join-Path $docsDir 'screenshots')
}

# 5. Purity gate and ZIP.
$forbidden = @()
$forbidden += Get-ChildItem -LiteralPath $stage -Recurse -Force -Directory | Where-Object { $_.Name -in @('.git','node_modules','test','tests') }
$forbidden += Get-ChildItem -LiteralPath $stage -Recurse -Force -File | Where-Object {
    $_.Name -in @('.env','server.js','license.js','sea-entry.js','package.json','package-lock.json') -or
    $_.Name -like '*.test.js' -or $_.Name -like 'probe-*' -or $_.Name -like 'stress-*'
}
if ($forbidden.Count -gt 0) { throw ('forbidden package entries: ' + ($forbidden.FullName -join '; ')) }
if ((Get-ChildItem -LiteralPath (Join-Path $appDir 'work\logs') -File).Count -ne 0) { throw 'logs directory is not empty' }
if ((Get-ChildItem -LiteralPath (Join-Path $appDir 'work\db-backups') -File).Count -ne 0) { throw 'backup directory is not empty' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $true)
$zipInfo = Get-Item -LiteralPath $zip
$zipHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{
    product = '老殷工控PLC助手'
    version = $ver.TrimStart('v')
    packageUrl = 'https://raw.githubusercontent.com/kcylp/laoyin-plc-ai/main/work/green-build/LaoyinPLC-Green-v1.0.2.zip'
    sha256 = $zipHash
    sizeBytes = [int64]$zipInfo.Length
    releaseNotes = '增加启动失败安全诊断日志，便于客户环境排查；保留联网检查更新、SHA256 校验、失败回滚与客户数据保护。'
    minLauncherVersion = $ver.TrimStart('v')
    publishedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}
$manifestPath = Join-Path $repo 'update-manifest.json'
$manifestJson = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, [System.Text.UTF8Encoding]::new($false))
$sizeMB = [math]::Round($zipInfo.Length / 1MB, 1)
Write-Output ("ZIP: " + $zip)
Write-Output ("SIZE_MB: " + $sizeMB)
Write-Output ("MANIFEST: " + $manifestPath)
Write-Output ("SHA256: " + $zipHash)
