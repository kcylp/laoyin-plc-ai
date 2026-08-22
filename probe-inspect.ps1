# Inspect: which blocks exist, and exactly where do compile errors hang in the
# message tree (full ancestry). Used to debug error attribution.
# Pure ASCII (PS 5.1 GBK trap).
param([Parameter(Mandatory)][string]$EngineRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Import-Module (Join-Path $EngineRoot 'src\EngineerYin.Write.psm1') -Force
$null = Initialize-YinAssemblies
$conn = Connect-YinPortal

$inv = Get-YinBlockInventory
Write-Output "BLOCKS: $($inv.Names -join ', ')"

$cmp = Invoke-YinCompile
Write-Output ("COMPILE state={0} errors={1} warnings={2}" -f $cmp.State, $cmp.ErrorCount, $cmp.WarningCount)
$cmp.Messages | Where-Object { $_.Description } | ForEach-Object {
    Write-Output ("[{0}] anc=<{1}> path=<{2}> {3}" -f $_.State, $_.Ancestry, $_.Path, $_.Description)
}

Disconnect-YinPortal
