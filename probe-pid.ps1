# Probe: can a PID_Compact multi-instance be generated from SCL source?
# Dragging PID_Compact into an FB in the TIA editor offers multi-instance,
# whose static datatype is "PID_Compact". If ExternalSources accepts that
# declaration, AI-generated PID loops work with zero manual steps.
# Pure ASCII (PS 5.1 GBK trap).
param([Parameter(Mandatory)][string]$EngineRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Import-Module (Join-Path $EngineRoot 'src\EngineerYin.Write.psm1') -Force
$null = Initialize-YinAssemblies
$conn = Connect-YinPortal
$utf8Bom = New-Object System.Text.UTF8Encoding($true)

$lines = @(
    'FUNCTION_BLOCK "ProbePidMulti"'
    "{ S7_Optimized_Access := 'TRUE' }"
    'VERSION : 0.1'
    'VAR_INPUT'
    '   Setpoint : Real;'
    '   ProcessValue : Real;'
    '   ManualEnable : Bool;'
    '   ManualValue : Real;'
    '   Reset : Bool;'
    'END_VAR'
    'VAR_OUTPUT'
    '   Output : Real;'
    '   Error : Bool;'
    'END_VAR'
    'VAR'
    '   Pid : PID_Compact;'
    'END_VAR'
    'BEGIN'
    '    #Pid(Setpoint := #Setpoint, Input := #ProcessValue, ManualEnable := #ManualEnable, ManualValue := #ManualValue, Reset := #Reset, Output => #Output, Error => #Error);'
    'END_FUNCTION_BLOCK'
)
$text = ([string]::Join("`n", $lines)) + "`n"

$srcPath = Join-Path $env:TEMP 'ProbePidMulti.scl'
try {
    [System.IO.File]::WriteAllText($srcPath, $text, $utf8Bom)
    $null = Import-YinSourceFile -SourcePath $srcPath -Overwrite
    Write-Output 'GEN ProbePidMulti -> gen-ok'
    $cmp = Invoke-YinCompile
    $mine = @($cmp.Messages | Where-Object {
        "$($_.Ancestry)/$($_.Path)" -like '*ProbePidMulti*' -and $_.Description
    })
    $errs = @($mine | Where-Object { "$($_.State)" -eq 'Error' })
    $warns = @($mine | Where-Object { "$($_.State)" -eq 'Warning' })
    Write-Output ("BLOCK ProbePidMulti errors=" + $errs.Count + " warnings=" + $warns.Count)
    $mine | Select-Object -First 8 | ForEach-Object { Write-Output ("    [" + $_.State + "] " + $_.Description) }
} catch {
    Write-Output ('GEN ProbePidMulti -> gen-fail: ' + $_.Exception.Message)
} finally {
    Remove-Item $srcPath -Force -ErrorAction SilentlyContinue
    try { $null = Remove-YinBlockByName -BlockName 'ProbePidMulti' } catch { }
}
Disconnect-YinPortal
