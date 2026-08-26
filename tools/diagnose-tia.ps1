# 老殷工控 PLC 助手 - TIA/Openness 脱敏诊断
# 只读：不会修改 TIA、工程、用户组、注册表或网络配置。
# 输出：work\diagnostics\tia-diagnostic-YYYYMMDD-HHmmss.json/.txt
[CmdletBinding()]
param(
    [string]$AppRoot = '',
    [switch]$SkipMcpDoctor
)

$ErrorActionPreference = 'SilentlyContinue'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
try { [Console]::OutputEncoding = $utf8NoBom } catch { }
$OutputEncoding = $utf8NoBom
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $AppRoot) {
    $AppRoot = Split-Path -Parent $scriptRoot
}
$AppRoot = [System.IO.Path]::GetFullPath($AppRoot)
$discoveryScript = Join-Path $AppRoot 'engine\src\YinTiaDiscovery.ps1'
if (Test-Path -LiteralPath $discoveryScript) { . $discoveryScript }
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

function Test-FileExists([string]$path) {
    try { return [bool](Test-Path -LiteralPath $path -PathType Leaf) } catch { return $false }
}

function Get-RegistryValueSafe([string]$path, [string]$name) {
    try {
        $item = Get-ItemProperty -LiteralPath $path -Name $name -ErrorAction Stop
        return [string]$item.$name
    } catch { return '' }
}

function Get-TiaInstalls([array]$rawInstalls) {
    $found = @()
    foreach ($install in @($rawInstalls)) {
        if (-not $install.EngineeringVersion) { continue }
        $found += [pscustomobject]@{
            Major = $install.Major
            RegistryVersion = $install.RegistryVersion
            EngineeringVersion = $install.EngineeringVersion
            Net48Exists = [bool]($install.PublicApiDir -and (Test-Path -LiteralPath $install.PublicApiDir -PathType Container))
            EngineeringBaseExists = [bool]$install.DllsPresent.EngineeringBase
            Step7Exists = [bool]($install.PortalRoot -and (Test-FileExists (Join-Path $install.PortalRoot 'Bin\Siemens.Engineering.SW.dll')))
            WinCCUnifiedExists = [bool]($install.PortalRoot -and (Test-FileExists (Join-Path $install.PortalRoot 'Bin\Siemens.Engineering.HmiUnified.dll')))
            PortalRoot = Mask-Path $install.PortalRoot
            PublicApiDir = Mask-Path $install.PublicApiDir
            PathSource = $install.PathSource
            DllsPresent = $install.DllsPresent
        }
    }
    return $found
}

function Get-DotNetFrameworkState {
    $path = 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full'
    $release = 0
    try { $release = [int](Get-ItemProperty -LiteralPath $path -Name Release -ErrorAction Stop).Release } catch { }
    return [pscustomobject]@{ Release = $release; Meets48 = ($release -ge 528040) }
}

function Get-ExecutionPolicyState {
    $effective = ''
    try { $effective = [string](Get-ExecutionPolicy -Scope Process -ErrorAction SilentlyContinue) } catch { }
    if (-not $effective -or $effective -eq 'Undefined') {
        try { $effective = [string](Get-ExecutionPolicy -ErrorAction SilentlyContinue) } catch { }
    }
    return [pscustomobject]@{ Effective = $effective }
}

function Get-TiaProcessState {
    $procs = @(Get-Process -Name 'Siemens.Automation.Portal' -ErrorAction SilentlyContinue)
    return [pscustomobject]@{
        Running = ($procs.Count -gt 0)
        ProcessCount = $procs.Count
        ProjectState = $(if ($procs.Count -gt 0) { 'running-project-unknown' } else { 'not-running' })
    }
}

function Get-MotwState {
    $count = 0
    try {
        $count = @(Get-ChildItem -LiteralPath $AppRoot -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
            $_.PSIsContainer -eq $false -and (Get-Item -LiteralPath ($_.FullName + ':Zone.Identifier') -ErrorAction SilentlyContinue)
        }).Count
    } catch { }
    return [pscustomobject]@{ BlockedCount = $count }
}

function Get-DefenderState {
    try {
        $threats = @(Get-MpThreatDetection -ErrorAction Stop | Select-Object -First 3)
        if ($threats.Count -gt 0) { return [pscustomobject]@{ Status = 'detected'; Message = ($threats | ForEach-Object { $_.ThreatName }) -join ', ' } }
        return [pscustomobject]@{ Status = 'clean'; Message = '未发现近期 Defender 威胁记录' }
    } catch {
        return [pscustomobject]@{ Status = 'unknown'; Message = '无法读取 Defender 记录' }
    }
}

function Get-LogPathWritableState {
    $paths = @(Join-Path $AppRoot 'work\diagnostics')
    $runtimeRoot = Join-Path $AppRoot 'engine\tia-mcp\runtime'
    if (Test-Path -LiteralPath $runtimeRoot) {
        $paths += @(Get-ChildItem -LiteralPath $runtimeRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^v\d+$' } | ForEach-Object { $_.FullName })
    }
    foreach ($dir in $paths) {
        try {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
            $probe = Join-Path $dir ('.write-test-' + [System.Guid]::NewGuid().ToString('n') + '.tmp')
            [System.IO.File]::WriteAllText($probe, 'ok', [System.Text.UTF8Encoding]::new($false))
            Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        } catch {
            return [pscustomobject]@{ Checked = $true; Writable = $false }
        }
    }
    return [pscustomobject]@{ Checked = $true; Writable = $true }
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

function Get-Port3000([bool]$detailed) {
    if (-not $detailed) {
        try {
            $listeners = @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq 3000 })
            return [pscustomobject]@{ InUse = $listeners.Count -gt 0; Pids = @() }
        } catch { return [pscustomobject]@{ InUse = $false; Pids = @() } }
    }
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

function Get-McpState([array]$rawInstalls) {
    $runtimeRoot = Join-Path $AppRoot 'engine\tia-mcp\runtime'
    $supportedByThisBuild = @(Get-ChildItem -LiteralPath $runtimeRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^v(\d+)$' } |
        ForEach-Object { [int]($_.Name.Substring(1)) } | Sort-Object)
    $selected = @($rawInstalls | Where-Object { $supportedByThisBuild -contains $_.Major } |
        Sort-Object Major -Descending | Select-Object -First 1)
    $selectedMajor = if ($selected.Count) { [int]$selected[0].Major } elseif ($supportedByThisBuild.Count) { [int]$supportedByThisBuild[-1] } else { 0 }
    $portal = if ($selected.Count) { [string]$selected[0].PortalRoot } else { '' }
    $exe = if ($selectedMajor) { Join-Path $runtimeRoot "v$selectedMajor\TiaMcpServer.exe" } else { '' }
    $detectedMajors = @($rawInstalls | ForEach-Object { [int]$_.Major } | Sort-Object -Unique)
    $state = [ordered]@{
        ExeExists = [bool]($exe -and (Test-Path -LiteralPath $exe))
        ExePath = Mask-Path $exe
        supportedByThisBuild = @($supportedByThisBuild)
        SelectedMajor = $selectedMajor
        Mismatch = $(if ($rawInstalls.Count -gt 0 -and $selected.Count -eq 0) {
            [ordered]@{ detected = @($detectedMajors); supported = @($supportedByThisBuild) }
        } else { $false })
        Version = ''
        Sha256 = ''
        DoctorAttempted = (-not $SkipMcpDoctor)
        DoctorExitCode = $null
        DoctorOk = $false
        DoctorMessage = ''
    }
    if (Test-Path -LiteralPath $exe) {
        try { $state.Version = (Get-Item -LiteralPath $exe).VersionInfo.FileVersion } catch { }
        if (-not $SkipMcpDoctor) {
            try { $state.Sha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash } catch { }
        }
    }
    if (-not $SkipMcpDoctor -and $state.ExeExists -and $portal) {
        try {
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = $exe
            $psi.Arguments = '--tia-portal-location "' + $portal + '" --tia-major-version ' + $selectedMajor + ' tia doctor'
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $true
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            $process = New-Object System.Diagnostics.Process
            $process.StartInfo = $psi
            [void]$process.Start()
            if (-not $process.WaitForExit(15000)) {
                try { $process.Kill() } catch { }
                $state.DoctorExitCode = -1
                $state.DoctorMessage = 'MCP doctor 超过 15 秒，已终止'
            } else {
                $state.DoctorExitCode = $process.ExitCode
                $state.DoctorOk = ($state.DoctorExitCode -eq 0)
                $lines = @($process.StandardOutput.ReadToEnd(), $process.StandardError.ReadToEnd())
                $state.DoctorMessage = (($lines | ForEach-Object { [string]$_ } | Select-Object -Last 8) -join ' ')
                if ($state.DoctorMessage.Length -gt 1000) { $state.DoctorMessage = $state.DoctorMessage.Substring(0,1000) }
            }
            $process.Dispose()
        } catch {
            $state.DoctorMessage = 'MCP doctor 无法启动'
        }
    }
    return [pscustomobject]$state
}

$os = if ($SkipMcpDoctor) {
    [pscustomobject]@{ Caption = 'Microsoft Windows'; Version = [System.Environment]::OSVersion.Version.ToString(); OSArchitecture = [string]$env:PROCESSOR_ARCHITECTURE }
} else {
    Get-CimInstance Win32_OperatingSystem
}
$dotnetFramework = Get-DotNetFrameworkState
$dotnet48 = $dotnetFramework.Meets48
$rawInstalls = if (Get-Command Get-YinTiaInstalls -ErrorAction SilentlyContinue) { @(Get-YinTiaInstalls) } else { @() }
$installs = @(Get-TiaInstalls $rawInstalls)
$group = Get-OpennessGroupState
$port = Get-Port3000(-not $SkipMcpDoctor)
$mcp = Get-McpState $rawInstalls
$executionPolicy = Get-ExecutionPolicyState
$tiaProcess = Get-TiaProcessState
if ($SkipMcpDoctor) {
    $motw = [pscustomobject]@{ BlockedCount = 0; Skipped = $true }
    $defender = [pscustomobject]@{ Status = 'unknown'; Message = '快速诊断跳过 Defender 记录读取' }
    $logPathWritable = [pscustomobject]@{ Checked = $false; Writable = $false }
} else {
    $motw = Get-MotwState
    $defender = Get-DefenderState
    $logPathWritable = Get-LogPathWritableState
}
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
    dotNetFramework = $dotnetFramework
    dotNetFramework48Key = $dotnet48
    executionPolicy = $executionPolicy
    tiaInstalls = $installs
    tiaDiscovery = [ordered]@{
        installedVersions = @($installs)
        selectedMajor = $mcp.SelectedMajor
        supportedByThisBuild = @($mcp.supportedByThisBuild)
        mismatch = $mcp.Mismatch
    }
    opennessGroup = $group
    port3000 = $port
    tiaProcess = $tiaProcess
    mcp = $mcp
    motw = $motw
    defender = $defender
    logPathWritable = $logPathWritable
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
    ('MCP ' + $(if ($mcp.SelectedMajor) { 'V' + $mcp.SelectedMajor } else { 'runtime' }) + ' 文件: ' + $(if ($mcp.ExeExists) { '存在' } else { '缺失' }))
    ('MCP doctor: ' + $(if ($mcp.DoctorOk) { '通过' } else { '未通过/未执行' }))
    ('端口 3000: ' + $(if ($port.InUse) { '占用' } else { '未占用' }))
    '问题:'
    $(if ($issues.Count) { $issues | ForEach-Object { '- ' + $_ } } else { '- 未发现基础环境问题' })
    ''
    '请将同名 JSON/TXT 一并交给管理员；不要发送 .env、数据库或日志文件。'
)
[System.IO.File]::WriteAllLines($textPath, $text, [System.Text.UTF8Encoding]::new($false))
Write-Output (ConvertTo-Json ([ordered]@{ json = $jsonPath; text = $textPath; issues = @($issues) }) -Compress)
