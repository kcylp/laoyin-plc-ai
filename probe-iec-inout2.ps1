# Probe round 2: how does a generic IEC_COUNTER InOut actually get driven?
# Round 1: CTU-style call (CU/R/PV/Q) on IEC_COUNTER InOut -> every formal
# parameter invalid. Candidates now:
#   A: full CTUD profile (CU/CD/R/LD/PV, QU=>/QD=>) - generic counter might
#      expose the union profile
#   B: no call at all, just read state members (.CV / .QU) - is read-only OK?
#   C: instruction-prefixed call "CTUD"(...) with the InOut as instance? (guess)
# Pure ASCII (PS 5.1 GBK trap).
param([Parameter(Mandatory)][string]$EngineRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Import-Module (Join-Path $EngineRoot 'src\EngineerYin.Write.psm1') -Force
$null = Initialize-YinAssemblies
$conn = Connect-YinPortal
$utf8Bom = New-Object System.Text.UTF8Encoding($true)

function Wrap([string]$name, [string[]]$body, [string[]]$extraOut) {
    $lines = @(
        'FUNCTION_BLOCK "' + $name + '"'
        "{ S7_Optimized_Access := 'TRUE' }"
        'VERSION : 0.1'
        'VAR_INPUT', '   Pulse : Bool;', '   Reset : Bool;', '   Preset : Int;', 'END_VAR'
        'VAR_OUTPUT', '   Done : Bool;', '   Value : Int;' ) + $extraOut + @(
        'END_VAR'
        'VAR_IN_OUT', '   Cnt : IEC_COUNTER;', 'END_VAR'
        'BEGIN'
    ) + $body + @('END_FUNCTION_BLOCK')
    return ([string]::Join("`n", $lines)) + "`n"
}

$jobs = @(
    @{ Name = 'ProbeGenCtud'; Text = (Wrap 'ProbeGenCtud' @(
        '    #Cnt(CU := #Pulse, CD := FALSE, R := #Reset, LD := FALSE, PV := #Preset, QU => #Done);'
        '    #Value := #Cnt.CV;'
    ) @()) }
    @{ Name = 'ProbeGenRead'; Text = (Wrap 'ProbeGenRead' @(
        '    #Value := #Cnt.CV;'
        '    #Done := #Cnt.QU;'
    ) @()) }
    @{ Name = 'ProbeGenNamed'; Text = (Wrap 'ProbeGenNamed' @(
        '    CTUD(#Cnt, CU := #Pulse, CD := FALSE, R := #Reset, LD := FALSE, PV := #Preset, QU => #Done);'
        '    #Value := #Cnt.CV;'
    ) @()) }
)

$generated = @()
foreach ($j in $jobs) {
    $srcPath = Join-Path $env:TEMP ($j.Name + '.scl')
    $status = 'gen-ok'
    try {
        [System.IO.File]::WriteAllText($srcPath, $j.Text, $utf8Bom)
        $null = Import-YinSourceFile -SourcePath $srcPath -Overwrite
        $generated += $j.Name
    } catch {
        $status = 'gen-fail: ' + $_.Exception.Message
    } finally {
        Remove-Item $srcPath -Force -ErrorAction SilentlyContinue
    }
    Write-Output ("GEN {0,-16} -> {1}" -f $j.Name, $status)
}

if ($generated.Count -gt 0) {
    $cmp = Invoke-YinCompile
    foreach ($name in $generated) {
        $mine = @($cmp.Messages | Where-Object {
            "$($_.Ancestry)/$($_.Path)" -like "*$name*" -and "$($_.State)" -eq 'Error' -and $_.Description
        })
        Write-Output ("BLOCK {0,-16} errors={1}" -f $name, $mine.Count)
        $mine | Select-Object -First 5 | ForEach-Object { Write-Output ("    " + $_.Description) }
    }
    foreach ($name in $generated) {
        try { $null = Remove-YinBlockByName -BlockName $name } catch { }
    }
}
Disconnect-YinPortal
