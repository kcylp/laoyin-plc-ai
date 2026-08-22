$ErrorActionPreference = 'Stop'
$zip = 'F:\工控软件\老殷工控PLC助手\work\green-build\老殷工控PLC助手_绿色版_v0.1.zip'
$extract = 'F:\工控软件\老殷工控PLC助手\work\green-build\verify-extract'
if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $extract)
$root = Join-Path $extract '老殷工控PLC助手'
Write-Output '=== 顶层结构 ==='
Get-ChildItem -LiteralPath $root | Select-Object Name, Length | Format-Table -AutoSize
Write-Output '=== 纯净性检查 ==='
$envCount = (Get-ChildItem -LiteralPath $root -Recurse -Force -Filter '.env' -File | Measure-Object).Count
$dbCount  = (Get-ChildItem -LiteralPath $root -Recurse -Filter '*.db' -File | Measure-Object).Count
$junk = Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.Name -like 'probe-*' -or $_.Name -like 'stress-*' -or $_.Name -like 'e2e-*' -or $_.Name -like 'smoke-*' }
$batCount = (Get-ChildItem -LiteralPath $root -Recurse -Include '*.bat','*.cmd' -File | Measure-Object).Count
Write-Output ("含 .env: " + $envCount)
Write-Output ("含 *.db: " + $dbCount)
Write-Output ("含 探针/压测/e2e: " + $junk.Count)
Write-Output ("含 bat/cmd: " + $batCount)
Write-Output ("启动器 EXE 存在: " + (Test-Path -LiteralPath (Join-Path $root '老殷工控PLC助手.exe')))
Write-Output ("node 运行时存在: " + (Test-Path -LiteralPath (Join-Path $root 'runtime\node.exe')))
$shotDir = Join-Path $root '说明文档\screenshots'
Write-Output ("截图数量: " + (Get-ChildItem -LiteralPath $shotDir -Filter '*.png' -File | Measure-Object).Count)
Write-Output '=== 端口 3000 占用检查 ==='
$conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($conn) { $conn | Select-Object LocalAddress, LocalPort, OwningProcess | Format-Table -AutoSize } else { Write-Output 'PORT_3000_FREE' }