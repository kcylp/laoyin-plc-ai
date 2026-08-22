# Cleanup: delete probe debris blocks (T_*, B_*, Attr_*) from the test project.
# Keeps Main and the Stress_* stress-test blocks. Recompiles afterwards and
# reports the final error count. Pure ASCII (PS 5.1 GBK trap).
param([Parameter(Mandatory)][string]$EngineRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Import-Module (Join-Path $EngineRoot 'src\EngineerYin.Write.psm1') -Force
$null = Initialize-YinAssemblies
$conn = Connect-YinPortal

$inv = Get-YinBlockInventory
$debris = @($inv.Names | Where-Object { $_ -match '^(T_|B_|Attr_)' })
Write-Output ("debris found: " + $debris.Count)
$debris | ForEach-Object { Write-Output ("  - " + $_) }

foreach ($name in $debris) {
    try {
        $removed = Remove-YinBlockByName -BlockName $name
        Write-Output ("DEL " + $name + "  (" + ($removed -join ', ') + ")")
    } catch {
        Write-Output ("DEL " + $name + "  FAILED: " + $_.Exception.Message)
    }
}

$inv2 = Get-YinBlockInventory
Write-Output ("blocks left: " + ($inv2.Names -join ', '))

$cmp = Invoke-YinCompile
Write-Output ("COMPILE state={0} errors={1} warnings={2}" -f $cmp.State, $cmp.ErrorCount, $cmp.WarningCount)
$cmp.Messages | Where-Object { $_.Description -and "$($_.State)" -eq 'Error' } |
    Select-Object -First 10 |
    ForEach-Object { Write-Output ("    " + $_.Description) }

Disconnect-YinPortal
