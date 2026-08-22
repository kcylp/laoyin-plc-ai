# Delete S7DCL probe debris blocks and save. Pure ASCII (PS 5.1 GBK trap).
param([Parameter(Mandatory)][string]$EngineRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Import-Module (Join-Path $EngineRoot 'src\EngineerYin.Write.psm1') -Force
$null = Initialize-YinAssemblies
$conn = Connect-YinPortal

foreach ($name in @('S7DCL_Clone', 'SDV2CtuStatic', 'SDV4EtNoTrail', 'SDV5CtuReal', 'S7DCL_RoundTrip')) {
    try {
        $removed = Remove-YinBlockByName -BlockName $name
        Write-Output ("DEL " + $name + "  (" + ($removed -join ', ') + ")")
    } catch {
        Write-Output ("DEL " + $name + "  skip: " + $_.Exception.Message)
    }
}

$inv = Get-YinBlockInventory
Write-Output ("blocks left: " + ($inv.Names -join ', '))
$cmp = Invoke-YinCompile -SaveAfter
Write-Output ("saved, compile " + $cmp.State)
Disconnect-YinPortal
