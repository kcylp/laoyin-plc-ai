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
foreach ($d in @('app','app\work\logs','app\work\db-backups','app\tools','runtime','说明文档')) {
    [System.IO.Directory]::CreateDirectory((Join-Path $stage $d)) | Out-Null
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

function Copy-WhitelistedTree([string]$sourceRoot, [string]$destRoot, [scriptblock]$allowFile) {
    if (-not (Test-Path -LiteralPath $sourceRoot)) { return }
    Get-ChildItem -LiteralPath $sourceRoot -Recurse -Force -File | Where-Object { & $allowFile $_ } | ForEach-Object {
        $relative = Get-PortableRelativePath $sourceRoot $_.FullName
        $dest = Join-Path $destRoot $relative
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $dest)) | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $dest
    }
}

function Assert-NoUnexpectedEngineRootFiles([string]$engineRoot) {
    $allowedEngineRootFiles = @(
        '任务书_全面升级_20260803.md',
        '任务书_TIA工程化改版_20260803.md',
        '任务书_TON与SR线圈格式攻坚_20260803.md',
        'HANDOFF_补充说明_给Codex.md',
        'HANDOFF_给Codex_审核_20260803.md',
        'HANDOFF_给Codex_遗留修复_20260803.md',
        'HANDOFF_架构与接口路线.md'
    )
    $unexpected = @(Get-ChildItem -LiteralPath $engineRoot -Force -File | Where-Object { $allowedEngineRootFiles -notcontains $_.Name })
    if ($unexpected.Count -gt 0) {
        $paths = $unexpected | ForEach-Object { 'engine\' + $_.Name }
        throw ('unexpected engine root file is not allowed in green package input: ' + ($paths -join '; '))
    }
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

function Assert-PackageZipClean([string]$zipPath) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        $badEntries = @($archive.Entries | Where-Object { -not (Test-AllowedZipPath $_.FullName) })
        if ($badEntries.Count -gt 0) {
            throw ('ZIP contains non-whitelisted entries: ' + (($badEntries | Select-Object -First 20 | ForEach-Object { $_.FullName }) -join '; '))
        }
    } finally {
        $archive.Dispose()
    }

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
    Get-ChildItem -LiteralPath $stage -Recurse -Force -File | Where-Object { $scanExtensions -contains $_.Extension } | ForEach-Object {
        $text = [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8)
        foreach ($rule in $rules) {
            if ($text -match $rule.Pattern) {
                $rel = Get-PortableRelativePath $stage $_.FullName
                throw ('sensitive package content: ' + $rule.Name + ' in ' + $rel)
            }
        }
    }
}

# 1. Bundle backend and create SEA executable.

Assert-NoUnexpectedEngineRootFiles (Join-Path $repo 'engine')

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
        $seaConfig = [ordered]@{
            main = (Join-Path $tools 'bundle.cjs')
            output = (Join-Path $tools 'sea-prep.blob')
            disableExperimentalSEAWarning = $true
            useSnapshot = $false
            useCodeCache = $true
        } | ConvertTo-Json -Depth 3
        [System.IO.File]::WriteAllText((Join-Path $tools 'sea-config.json'), $seaConfig, [System.Text.UTF8Encoding]::new($false))
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
$frontendFiles = @(
    'index.html','login.html','settings.html','env-check.html','upgrade.html',
    'style.css','login.css','admin.css','operations.css','tia.css','upgrade.css',
    'ai-models.js','plc-language.js','tia-confirmation.js','tia-import-state.js','login.js','admin.js','upgrade.js'
)
foreach ($f in $frontendFiles) { Copy-Item -LiteralPath (Join-Path $repo $f) -Destination $appDir }
$adminHtml = [System.IO.File]::ReadAllText((Join-Path $repo 'admin.html'), [System.Text.Encoding]::UTF8)
$adminHtml = $adminHtml.Replace('在 .env 文件的 ADMIN_KEY 中配置', '由启动器生成并保存在本机安全配置中')
[System.IO.File]::WriteAllText((Join-Path $appDir 'admin.html'), $adminHtml, [System.Text.UTF8Encoding]::new($false))
Copy-WhitelistedTree (Join-Path $repo 'web') (Join-Path $appDir 'web') { param($file) $file.Extension -in @('.js','.css') }
Copy-WhitelistedTree (Join-Path $repo 'engine\src') (Join-Path $appDir 'engine\src') { param($file) $file.Extension -in @('.ps1','.psm1','.xsd') -and $file.Name -ne 'test_validate.ps1' }
Copy-WhitelistedTree (Join-Path $repo 'engine\schemas') (Join-Path $appDir 'engine\schemas') { param($file) $file.Extension -eq '.xsd' }
Copy-WhitelistedTree (Join-Path $repo 'engine\tia-mcp\runtime') (Join-Path $appDir 'engine\tia-mcp\runtime') { param($file) $file.FullName -match '\\runtime\\v[^\\]+\\' }
[System.IO.Directory]::CreateDirectory((Join-Path $appDir 'engine\tia-mcp\manifest')) | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'engine\tia-mcp\manifest\tools-list.json') -Destination (Join-Path $appDir 'engine\tia-mcp\manifest\tools-list.json')
Copy-Item -LiteralPath (Join-Path $repo 'tools\diagnose-tia.ps1') -Destination (Join-Path $appDir 'tools')

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
- 审计日志与数据库备份保存在：%LOCALAPPDATA%\老殷工控PLC助手\logs 和 db-backups
- 删除或修改授权文件会导致授权失效，不会自动重置试用期。
- API Key 加密存储；复制程序目录不会复制客户 Key。

目录结构
- 老殷工控PLC助手.exe：启动器与托盘管理
- runtime\laoyin-server.exe：SEA 单文件后端（不需要客户安装 Node.js）
- 老殷工控PLC助手更新器.exe：安全更新与失败回滚
- app\web、HTML、CSS：浏览器界面资产
- app\engine：TIA Openness、MCP 与 PowerShell 引擎（必须保持真实路径）
- app\tools\diagnose-tia.ps1：客户环境诊断脚本
- app\work：兼容旧版的空运行目录
- 说明文档：用户手册

Windows SmartScreen 提示
- 首次运行时 Windows 可能显示“已保护你的电脑”。
- 请点击“更多信息”→“仍要运行”启动本软件。
- 当前绿色版尚未配置 Authenticode 代码签名证书；我们不伪造签名，也不声称已完成系统级签名验证。

注意
- 只支持 Windows 10/11 64 位。
- 端口 3000 被占用时程序会中文提示，不会静默失败。
- TIA 功能需要本机安装兼容的 Siemens TIA Portal/Openness 环境。
"@, $enc)

$manual = Join-Path $repo 'docs\green-edition\绿色版用户手册.md'
if (Test-Path -LiteralPath $manual) { Copy-Item -LiteralPath $manual -Destination $docsDir }
foreach ($ext in @('docx','pdf')) {
    $doc = Join-Path $repo ("docs\green-edition\绿色版用户手册." + $ext)
    if (Test-Path -LiteralPath $doc) { Copy-Item -LiteralPath $doc -Destination $docsDir }
}

# 5. Purity gate and ZIP.
if ((Get-ChildItem -LiteralPath (Join-Path $appDir 'work\logs') -File).Count -ne 0) { throw 'logs directory is not empty' }
if ((Get-ChildItem -LiteralPath (Join-Path $appDir 'work\db-backups') -File).Count -ne 0) { throw 'backup directory is not empty' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $true)
Assert-PackageZipClean $zip
$zipInfo = Get-Item -LiteralPath $zip
$zipHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{
    product = '老殷工控PLC助手'
    version = $ver.TrimStart('v')
    packageUrl = 'https://github.com/kcylp/laoyin-plc-ai/releases/download/v1.0.2/LaoyinPLC-Green-v1.0.2.zip'
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
