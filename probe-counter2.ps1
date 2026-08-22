# Probe round 2: counter output access styles. Round 1 showed CTU_INT calls
# compile but post-access #Cnt.Q fails with "Tag #Cnt.Q not defined".
# A: outputs bound inside the call with => (classic TIA SCL style)
# B: post-access of .Q and .CV (what failed)
# C: mixed - => for Q only, post-access .CV
# Pure ASCII (PS 5.1 GBK trap).
param([Parameter(Mandatory)][string]$EngineRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Import-Module (Join-Path $EngineRoot 'src\EngineerYin.Write.psm1') -Force
$null = Initialize-YinAssemblies
$conn = Connect-YinPortal
$utf8Bom = New-Object System.Text.UTF8Encoding($true)

function Wrap([string]$name, [string[]]$body) {
    $lines = @(
        'FUNCTION_BLOCK "' + $name + '"'
        "{ S7_Optimized_Access := 'TRUE' }"
        'VERSION : 0.1'
        'VAR_INPUT', '   Pulse : Bool;', '   Reset : Bool;', '   Preset : Int;', 'END_VAR'
        'VAR_OUTPUT', '   Done : Bool;', '   CurrentValue : Int;', 'END_VAR'
        'VAR', '   Cnt : CTU_INT;', 'END_VAR'
        'BEGIN'
    ) + $body + @('END_FUNCTION_BLOCK')
    return ([string]::Join("`n", $lines)) + "`n"
}

$jobs = @(
    @{ Name = 'ProbeCtuArrow'; Text = (Wrap 'ProbeCtuArrow' @(
        '    #Cnt(CU := #Pulse, R := #Reset, PV := #Preset, Q => #Done, CV => #CurrentValue);')) }
    @{ Name = 'ProbeCtuPost'; Text = (Wrap 'ProbeCtuPost' @(
        '    #Cnt(CU := #Pulse, R := #Reset, PV := #Preset);'
        '    #Done := #Cnt.Q;'
        '    #CurrentValue := #Cnt.CV;')) }
    @{ Name = 'ProbeCtuMixed'; Text = (Wrap 'ProbeCtuMixed' @(
        '    #Cnt(CU := #Pulse, R := #Reset, PV := #Preset, Q => #Done);'
        '    #CurrentValue := #Cnt.CV;')) }
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
        $mine | Select-Object -First 4 | ForEach-Object { Write-Output ("    " + $_.Description) }
    }
    foreach ($name in $generated) {
        try { $null = Remove-YinBlockByName -BlockName $name } catch { }
    }
}
Disconnect-YinPortal
