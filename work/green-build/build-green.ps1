# Green portable build: launcher EXE + Node SEA backend + external UI/TIA assets.
$ErrorActionPreference = 'Stop'
$repo = 'F:\工控软件\老殷工控PLC助手'
$root = Join-Path $repo 'work\green-build'
$tools = Join-Path $repo 'work\sea-toolchain'
$stage = Join-Path $root 'stage\老殷工控PLC助手'
$ver = 'v1.0'
$zip = Join-Path $root ("老殷工控PLC助手_绿色免安装版_" + $ver + ".zip")
$node = 'D:\DevTools\nodejs\node.exe'
$signtool = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
foreach ($d in @('app','app\work\logs','app\work\db-backups','runtime','说明文档\screenshots')) {
    [System.IO.Directory]::CreateDirectory((Join-Path $stage $d)) | Out-Null
}

# 1. Bundle backend and create SEA executable.
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

# 2. External assets required by browser and TIA Openness.
$appDir = Join-Path $stage 'app'
$frontendJs = @('ai-models.js','plc-language.js','tia-confirmation.js','tia-import-state.js','login.js','admin.js','upgrade.js')
foreach ($f in $frontendJs) { Copy-Item -LiteralPath (Join-Path $repo $f) -Destination $appDir }
Get-ChildItem -LiteralPath $repo -File -Filter '*.html' | Copy-Item -Destination $appDir
Get-ChildItem -LiteralPath $repo -File -Filter '*.css' | Copy-Item -Destination $appDir
Copy-Item -LiteralPath (Join-Path $repo 'web') -Destination $appDir -Recurse
Copy-Item -LiteralPath (Join-Path $repo 'engine') -Destination $appDir -Recurse

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
& $csc /nologo /target:winexe /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /out:$launcher (Join-Path $root 'launcher.cs')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcher)) { throw 'launcher compile failed' }

# 4. Customer documentation.
$enc = [System.Text.UTF8Encoding]::new($false)
$docsDir = Join-Path $stage '说明文档'
[System.IO.File]::WriteAllText((Join-Path $stage 'README_请先看.txt'), @"
【老殷工控 PLC 助手 - 绿色免安装版 v1.0】

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
- app\web、HTML、CSS：浏览器界面资产
- app\engine：TIA Openness、MCP 与 PowerShell 引擎（必须保持真实路径）
- app\work：运行日志与数据库备份目录
- 说明文档：用户手册与验收截图

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
$sizeMB = [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1)
Write-Output ("ZIP: " + $zip)
Write-Output ("SIZE_MB: " + $sizeMB)
