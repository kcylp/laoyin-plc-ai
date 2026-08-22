# Decisive check: full Stress_ConveyorFSM.scl, written WITH a UTF-8 BOM.
# If the GBK-misdecode theory is right, generation + compile comes back clean.
# Pure ASCII (PS 5.1 GBK trap).
param([Parameter(Mandatory)][string]$EngineRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Import-Module (Join-Path $EngineRoot 'src\EngineerYin.Write.psm1') -Force
$null = Initialize-YinAssemblies
$conn = Connect-YinPortal

$dataDir = Join-Path (Split-Path $EngineRoot -Parent) 'work\probe'
$src = [System.IO.File]::ReadAllText((Join-Path $dataDir 'Stress_ConveyorFSM.scl'), [System.Text.Encoding]::UTF8)

$srcPath = Join-Path $env:TEMP 'Stress_ConveyorFSM.scl'
[System.IO.File]::WriteAllText($srcPath, $src, (New-Object System.Text.UTF8Encoding($true)))
try {
    $null = Import-YinSourceFile -SourcePath $srcPath -Overwrite
    $cmp = Invoke-YinCompile
    $mine = @($cmp.Messages | Where-Object {
        "$($_.Ancestry)/$($_.Path)" -like '*Stress_ConveyorFSM*' -and "$($_.State)" -eq 'Error' -and $_.Description
    })
    Write-Output ("BOM variant: errors=" + $mine.Count)
    $mine | Select-Object -First 5 | ForEach-Object { Write-Output ("    " + $_.Description) }
} finally {
    Remove-Item $srcPath -Force -ErrorAction SilentlyContinue
}
Disconnect-YinPortal
