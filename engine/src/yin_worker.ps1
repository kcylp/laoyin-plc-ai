param([Parameter(Mandatory)][string]$EngineRoot)
# Persistent Yin worker. ASCII-only by design; stdout is protocol JSON only.

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot 'YinImportCore.ps1')

$script:workerConn = $null
$script:workerConnected = $false

function Send-YinResponse($id, $body) {
    $out = [ordered]@{ id = $id }
    if ($body) {
        foreach ($p in $body.PSObject.Properties) {
            $out[$p.Name] = $p.Value
        }
    }
    Write-YinJsonLine ([pscustomobject]$out)
}

function Test-YinWorkerSession {
    if (-not $script:workerConnected -or -not $script:workerConn) { return $false }
    try { return [bool](Test-YinPortalConnection) } catch { return $false }
}

function Ensure-YinWorkerSession {
    if ($script:workerConnected) {
        if (Test-YinWorkerSession) { return $script:workerConn }
        Stop-YinWorkerSession
    }
    $script:workerConn = Connect-YinImportSession -EngineRoot $EngineRoot
    $script:workerConnected = $true
    return $script:workerConn
}

function Stop-YinWorkerSession {
    if ($script:workerConnected) {
        try { Disconnect-YinPortal } catch { }
    }
    $script:workerConnected = $false
    $script:workerConn = $null
}

function Invoke-YinWorkerImportWithReconnect {
    param(
        [Parameter(Mandatory)][ValidateSet('preflight', 'import')][string]$Mode,
        [Parameter(Mandatory)][string]$XmlPath,
        [switch]$Overwrite,
        [ValidateSet('xml', 'scl', 'stl')][string]$Kind = 'xml'
    )

    # Ensure-YinWorkerSession performs the required pre-op liveness probe and
    # reconnects stale TIA sessions before dispatch. Do not retry after the
    # import starts: a thrown import error may be a business-rule failure, and
    # rerunning it could duplicate writes.
    $conn = Ensure-YinWorkerSession
    return Invoke-YinImportRequest -EngineRoot $EngineRoot -Mode $Mode -XmlPath $XmlPath -Overwrite:$Overwrite -Kind $Kind -Connection $conn
}

try {
    Initialize-YinImportCore -EngineRoot $EngineRoot
    try { $null = Ensure-YinWorkerSession } catch { [Console]::Error.WriteLine($_.Exception.Message) }

    while (($line = [Console]::In.ReadLine()) -ne $null) {
        if (-not $line.Trim()) { continue }
        $msg = $null
        try {
            $msg = $line | ConvertFrom-Json
            $id = $msg.id
            $op = [string]$msg.op

            if ($op -eq 'shutdown') {
                Stop-YinWorkerSession
                Send-YinResponse $id ([pscustomobject]@{ ok = $true; stage = 'shutdown' })
                break
            }

            $conn = Ensure-YinWorkerSession

            if ($op -eq 'ping') {
                $tiaVersion = ''
                try { $tiaVersion = (Get-YinTiaInstall).EngineeringVersion } catch { }
                Send-YinResponse $id ([pscustomobject]@{
                    ok         = $true
                    pong       = $true
                    tiaVersion = $tiaVersion
                    project    = $conn.ProjectName
                })
            }
            elseif ($op -eq 'inventory') {
                $inv = Get-YinBlockInventory
                Send-YinResponse $id ([pscustomobject]@{
                    ok            = $true
                    stage         = 'inventory'
                    project       = $conn.ProjectName
                    plc           = $inv.PlcName
                    existingCount = $inv.Count
                    existingNames = @($inv.Names)
                })
            }
            elseif ($op -eq 'preflight' -or $op -eq 'import') {
                $kind = if ($msg.kind) { [string]$msg.kind } else { 'xml' }
                $overwrite = $false
                if ($msg.PSObject.Properties.Name -contains 'overwrite') { $overwrite = [bool]$msg.overwrite }
                $result = Invoke-YinWorkerImportWithReconnect -Mode $op -XmlPath ([string]$msg.path) -Overwrite:$overwrite -Kind $kind
                Send-YinResponse $id $result
            }
            else {
                Send-YinResponse $id ([pscustomobject]@{ ok = $false; stage = 'error'; message = "Unknown op: $op" })
            }
        }
        catch {
            $rid = if ($msg -and $msg.id) { $msg.id } else { 0 }
            Send-YinResponse $rid ([pscustomobject]@{
                ok      = $false
                stage   = 'error'
                message = $_.Exception.Message
            })
        }
    }
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
}
finally {
    Stop-YinWorkerSession
}
