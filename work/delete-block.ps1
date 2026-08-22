# Delete a block by name via the self-built engine, then save.
param([Parameter(Mandatory)][string]$EngineRoot, [Parameter(Mandatory)][string]$BlockName)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Import-Module (Join-Path $EngineRoot 'src\EngineerYin.Write.psm1') -Force
$null = Initialize-YinAssemblies
$conn = Connect-YinPortal
$removed = Remove-YinBlockByName -BlockName $BlockName
Write-Output ("removed: " + ($removed -join ', '))
$null = Invoke-YinCompile -SaveAfter
Disconnect-YinPortal
