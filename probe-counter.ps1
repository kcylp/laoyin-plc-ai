# Probe: which counter datatype keyword survives SCL ExternalSources import?
# IEC_COUNTER (generic) failed with "Invalid function name" / "#Cnt.Q not
# defined". Try the concrete multi-instance types CTU_INT / CTD_INT / CTUD_INT.
# Pure ASCII (PS 5.1 GBK trap); no Chinese in these sources.
param([Parameter(Mandatory)][string]$EngineRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Import-Module (Join-Path $EngineRoot 'src\EngineerYin.Write.psm1') -Force
$null = Initialize-YinAssemblies
$conn = Connect-YinPortal
$utf8Bom = New-Object System.Text.UTF8Encoding($true)

function Scl([string]$name, [string]$declType, [string]$call) {
    $lines = @(
        'FUNCTION_BLOCK "' + $name + '"'
        "{ S7_Optimized_Access := 'TRUE' }"
        'VERSION : 0.1'
        'VAR_INPUT', '   Pulse : Bool;', '   Reset : Bool;', '   Preset : Int;', 'END_VAR'
        'VAR_OUTPUT', '   Done : Bool;', '   CurrentValue : Int;', 'END_VAR'
        'VAR', '   Cnt : ' + $declType + ';', 'END_VAR'
        'BEGIN'
        '    ' + $call
        '    #Done := #Cnt.Q;'
        '    #CurrentValue := #Cnt.CV;'
        'END_FUNCTION_BLOCK'
    )
    return ([string]::Join("`n", $lines)) + "`n"
}

$jobs = @(
    @{ Name = 'ProbeCtuInt';  Text = (Scl 'ProbeCtuInt'  'CTU_INT'  '#Cnt(CU := #Pulse, R := #Reset, PV := #Preset);') }
    @{ Name = 'ProbeCtdInt';  Text = (Scl 'ProbeCtdInt'  'CTD_INT'  '#Cnt(CD := #Pulse, LD := #Reset, PV := #Preset);') }
    @{ Name = 'ProbeCtudInt'; Text = (Scl 'ProbeCtudInt' 'CTUD_INT' '#Cnt(CU := #Pulse, CD := #Reset, R := FALSE, LD := FALSE, PV := #Preset);') }
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
    Write-Output ("GEN {0,-14} -> {1}" -f $j.Name, $status)
}

if ($generated.Count -gt 0) {
    $cmp = Invoke-YinCompile
    foreach ($name in $generated) {
        $mine = @($cmp.Messages | Where-Object {
            "$($_.Ancestry)/$($_.Path)" -like "*$name*" -and "$($_.State)" -eq 'Error' -and $_.Description
        })
        Write-Output ("BLOCK {0,-14} errors={1}" -f $name, $mine.Count)
        $mine | Select-Object -First 4 | ForEach-Object { Write-Output ("    " + $_.Description) }
    }
    foreach ($name in $generated) {
        try { $null = Remove-YinBlockByName -BlockName $name } catch { }
    }
}
Disconnect-YinPortal
