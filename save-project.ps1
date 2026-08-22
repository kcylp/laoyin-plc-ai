# Save the attached TIA project so block deletions persist.
# Pure ASCII (PS 5.1 GBK trap).
param([Parameter(Mandatory)][string]$EngineRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Import-Module (Join-Path $EngineRoot 'src\EngineerYin.Write.psm1') -Force
$null = Initialize-YinAssemblies
$conn = Connect-YinPortal
$cmp = Invoke-YinCompile -SaveAfter
Write-Output ("saved: " + $conn.ProjectName + " (compile " + $cmp.State + ")")
Disconnect-YinPortal
