# 老殷工控 PLC 助手 - TIA/Openness 脱敏诊断
# 只读：不会修改 TIA、工程、用户组、注册表或网络配置。
# 输出：work\diagnostics\tia-diagnostic-YYYYMMDD-HHmmss.json/.txt
[CmdletBinding()]
param(
    [string]$AppRoot = '',
    [switch]$SkipMcpDoctor
)

$ErrorActionPreference = 'SilentlyContinue'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $AppRoot) {
    $AppRoot = Split-Path -Parent $scriptRoot
}
$AppRoot = [System.IO.Path]::GetFullPath($AppRoot)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outDir = Join-Path $AppRoot 'work\diagnostics'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$jsonPath = Join-Path $outDir "tia-diagnostic-$stamp.json"
$textPath = Join-Path $outDir "tia-diagnostic-$stamp.txt"

function Mask-Path([string]$value) {
    if (-not $value) { return '' }
    try {
        $full = [System.IO.Path]::GetFullPath($value)
        $root = [System.IO.Path]::GetPathRoot($full)
        $parts = $full.Substring($root.Length).Trim('\').Split('\') | Where-Object { $_ }
        $tail = @($parts | Select-Object -Last 2) -join '\'
        if ($root) { return ($root + '...\' + $tail) }
        return $tail
    } catch { return '<path>' }
}

function Test-RegistryKey([string]$path) {
    try { return [bool](Test-Path -LiteralPath $path) } catch { return $false }
}

function Get-RegistryValueSafe([string]$path, [string]$name) {
    try {
        $item = Get-ItemProperty -LiteralPath $path -Name $name -ErrorAction Stop
        return [string]$item.$name
    } catch { return '' }
}

function Get-TiaInstalls {
    $found = @()
    $root = 'HKLM:\SOFTWARE\Siemens\Automation\Openness'
    if (-not (Test-Path $root)) { return $found }
    foreach ($node in @(Get-ChildItem $root -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^\d+\.\d+$' })) {
        $version = $node.PSChildName
        $publicApi = Join-Path $node.PSPath 'PublicAPI'
        foreach ($asmNode in @(Get-ChildItem $publicApi -ErrorAction SilentlyContinue | Sort-Object PSChildName -Descending)) {
            $engineering = Get-RegistryValueSafe $asmNode.PSPath 'EngineeringVersion'
            if (-not $engineering) { continue }
            $net48 = Join-Path $env:ProgramFiles ("Siemens\Automation\Portal $engineering\PublicAPI\$engineering\net48")
            $dll = Join-Path $net48 'Siemens.Engineering.Base.dll'
            $found += [pscustomobject]@{
                RegistryVersion = $version
                EngineeringVersion = $engineering
                Net48Exists = Test-Path -LiteralPath $net48
                EngineeringBaseExists = Test-Path -LiteralPath $dll
                PortalRoot = Mask-Path (Join-Path $env:ProgramFiles ("Siemens\Automation\Portal $engineering"))
            }
            break
        }
    }
    return $found
}

function Get-OpennessGroupState {
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
        $group = New-Object System.Security.Principal.NTAccount($env:COMPUTERNAME, 'Siemens TIA Openness')
        $sid = $group.Translate([System.Security.Principal.SecurityIdentifier]).Value
        return [pscustomobject]@{ Checked = $true; InGroup = $principal.IsInRole($sid); Group = 'Siemens TIA Openness' }
    } catch {
        return [pscustomobject]@{ Checked = $false; InGroup = $false; Group = 'Siemens TIA Openness' }
    }
}

function Get-Port3000 {
    try {
        $listeners = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction Stop)
        return [pscustomobject]@{ InUse = $listeners.Count -gt 0; Pids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique) }
    } catch {
        try {
            $text = & netstat.exe -ano -p tcp 2>$null | Select-String ':3000\s+.*LISTENING\s+(\d+)'
            return [pscustomobject]@{ InUse = @($text).Count -gt 0; Pids = @($text | ForEach-Object { $_.Matches[0].Groups[1].Value }) }
        } catch { return [pscustomobject]@{ InUse = $false; Pids = @() } }
    }
}

function Get-McpState {
    $exe = Join-Path $AppRoot 'engine\tia-mcp\runtime\v21\TiaMcpServer.exe'
    $state = [ordered]@{
        ExeExists = Test-Path -LiteralPath $exe
        ExePath = Mask-Path $exe
        Version = ''
        Sha256 = ''
        DoctorAttempted = (-not $SkipMcpDoctor)
        DoctorExitCode = $null
        DoctorOk = $false
        DoctorMessage = ''
    }
    if (Test-Path -LiteralPath $exe) {
        try { $state.Version = (Get-Item -LiteralPath $exe).VersionInfo.FileVersion } catch { }
        try { $state.Sha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash } catch { }
    }
    if (-not $SkipMcpDoctor -and $state.ExeExists) {
        $portal = Join-Path $env:ProgramFiles 'Siemens\Automation\Portal V21'
        $lines = @()
        try {
            $lines = @(& $exe --tia-portal-location $portal --tia-major-version 21 tia doctor 2>&1)
            $state.DoctorExitCode = $LASTEXITCODE
            $state.DoctorOk = ($state.DoctorExitCode -eq 0)
            $state.DoctorMessage = (($lines | ForEach-Object { [string]$_ } | Select-Object -Last 8) -join ' ')
            if ($state.DoctorMessage.Length -gt 1000) { $state.DoctorMessage = $state.DoctorMessage.Substring(0,1000) }
        } catch {
            $state.DoctorMessage = 'MCP doctor 无法启动'
        }
    }
    return [pscustomobject]$state
}

$os = Get-CimInstance Win32_OperatingSystem
$dotnet48 = Test-Path 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full'
$installs = @(Get-TiaInstalls)
$group = Get-OpennessGroupState
$port = Get-Port3000
$mcp = Get-McpState
$issues = @()
if ($installs.Count -eq 0) { $issues += '未检测到 TIA Portal Openness 注册信息' }
if ($installs.Count -gt 0 -and -not ($installs | Where-Object { $_.EngineeringBaseExists })) { $issues += '检测到 TIA 版本，但 Siemens.Engineering.Base.dll 不存在' }
if (-not $mcp.ExeExists) { $issues += '绿色包缺少 TiaMcpServer.exe' }
if ($mcp.DoctorAttempted -and -not $mcp.DoctorOk) { $issues += 'MCP doctor 未通过；请查看 DoctorMessage 和安装版本' }
if ($group.Checked -and -not $group.InGroup) { $issues += '当前 Windows 用户不在 Siemens TIA Openness 组' }
if ($port.InUse) { $issues += '端口 3000 已被占用（若不是本程序）' }
if (-not $dotnet48) { $issues += '未检测到 .NET Framework 4.x Full 注册项' }

$result = [ordered]@{
    format = 'laoyin-tia-diagnostic-v1'
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    appRoot = Mask-Path $AppRoot
    user = if ($env:USERNAME) { $env:USERNAME.Substring(0, [Math]::Min(2, $env:USERNAME.Length)) + '***' } else { '' }
    computer = if ($env:COMPUTERNAME) { $env:COMPUTERNAME.Substring(0, [Math]::Min(2, $env:COMPUTERNAME.Length)) + '***' } else { '' }
    os = [ordered]@{ Caption = $os.Caption; Version = $os.Version; Architecture = $os.OSArchitecture }
    dotNetFramework48Key = $dotnet48
    tiaInstalls = $installs
    opennessGroup = $group
    port3000 = $port
    mcp = $mcp
    issues = @($issues)
    secretPolicy = '本报告不读取 .env、数据库、日志正文、API Key、JWT 或 SMTP 凭据'
}
$json = $result | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($jsonPath, $json, [System.Text.UTF8Encoding]::new($false))
$text = @(
    '老殷工控 PLC 助手 TIA/Openness 脱敏诊断'
    ('生成时间: ' + $result.generatedAt)
    ('TIA 安装数: ' + $installs.Count)
    ('当前用户 Openness 组: ' + $(if ($group.InGroup) { '是' } else { '否/无法确认' }))
    ('MCP V21 文件: ' + $(if ($mcp.ExeExists) { '存在' } else { '缺失' }))
    ('MCP doctor: ' + $(if ($mcp.DoctorOk) { '通过' } else { '未通过/未执行' }))
    ('端口 3000: ' + $(if ($port.InUse) { '占用' } else { '未占用' }))
    '问题:'
    $(if ($issues.Count) { $issues | ForEach-Object { '- ' + $_ } } else { '- 未发现基础环境问题' })
    ''
    '请将同名 JSON/TXT 一并交给管理员；不要发送 .env、数据库或日志文件。'
)
[System.IO.File]::WriteAllLines($textPath, $text, [System.Text.UTF8Encoding]::new($false))
Write-Output (ConvertTo-Json ([ordered]@{ json = $jsonPath; text = $textPath; issues = @($issues) }) -Compress)