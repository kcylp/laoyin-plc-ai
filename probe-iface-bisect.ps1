# Probe round 4: bisect the Stress_ConveyorFSM INTERFACE section by section.
# Round 3 showed: full SCL source loses its whole interface at generation
# (22x "Tag not defined") while every single construct alone survives.
# Code lands, interface does not - so the killer is in the VAR sections.
# I0 = full interface verbatim + trivial body (verdict: interface vs body)
# I1..I4 = one full section each, minimal other sections.
# Pure ASCII (PS 5.1 GBK trap); Chinese text only inside the UTF-8 data file,
# read back with explicit UTF-8 decoding.
param([Parameter(Mandatory)][string]$EngineRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Import-Module (Join-Path $EngineRoot 'src\EngineerYin.Write.psm1') -Force
$null = Initialize-YinAssemblies
$conn = Connect-YinPortal

$dataDir = Join-Path (Split-Path $EngineRoot -Parent) 'work\probe'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# Pull the four VAR sections verbatim out of the full source file.
$full = [System.IO.File]::ReadAllText((Join-Path $dataDir 'Stress_ConveyorFSM.scl'), [System.Text.Encoding]::UTF8)
function Section([string]$text, [string]$header) {
    $m = [regex]::Match($text, '(?ms)^' + $header + '\s*$.*?^END_VAR\s*$')
    if (-not $m.Success) { throw "section $header not found" }
    return $m.Value
}
$secInput  = Section $full 'VAR_INPUT'
$secOutput = Section $full 'VAR_OUTPUT'
$secStatic = Section $full 'VAR'        # regex: first ^VAR$ line (VAR$ anchor excludes VAR_INPUT)
$secTemp   = Section $full 'VAR_TEMP'

function Scl([string]$name, [string[]]$lines) {
    return ([string]::Join("`n", (@('FUNCTION_BLOCK "' + $name + '"', "{ S7_Optimized_Access := 'TRUE' }", 'VERSION : 0.1') + $lines + @('END_FUNCTION_BLOCK'))) + "`n")
}

$jobs = @()

# I0: full interface verbatim, trivial body touching every tag
$jobs += @{ Name = 'ProbeI0All'; Text = (Scl 'ProbeI0All' @(
    $secInput, $secOutput, $secStatic, $secTemp,
    'BEGIN',
    '    #StartPulse := #StartCmd AND #StopCmd AND #ResetFault;',
    '    #PrevStart := #StartCmd;',
    '    #MotorRun[1] := #StationSensor[1] AND #MotorFeedback[1];',
    '    #SystemState := 0;',
    '    #FaultCode := 0;',
    '    #CycleCount := 0;',
    '    #StepTimer[1](IN := #StartCmd, PT := T#2S);',
    '    #FaultTimer(IN := #StopCmd, PT := T#3S);',
    '    #FaultLatch := #StartPulse;',
    '    #CurrentStation := 1;',
    '    #i := 0;',
    '    #AllHome := #StartPulse;')) }

# I1: full VAR_INPUT only
$jobs += @{ Name = 'ProbeI1Input'; Text = (Scl 'ProbeI1Input' @(
    $secInput,
    'VAR_OUTPUT', '   OutSig : Bool;', 'END_VAR',
    'BEGIN',
    '    #OutSig := #StartCmd AND #StopCmd AND #ResetFault AND #StationSensor[1] AND #MotorFeedback[2];')) }

# I2: full VAR_OUTPUT only
$jobs += @{ Name = 'ProbeI2Output'; Text = (Scl 'ProbeI2Output' @(
    'VAR_INPUT', '   InSig : Bool;', 'END_VAR',
    $secOutput,
    'BEGIN',
    '    #MotorRun[1] := #InSig;',
    '    #SystemState := 0;',
    '    #FaultCode := 0;',
    '    #CycleCount := 0;')) }

# I3: full VAR (static) only
$jobs += @{ Name = 'ProbeI3Static'; Text = (Scl 'ProbeI3Static' @(
    'VAR_INPUT', '   InSig : Bool;', 'END_VAR',
    'VAR_OUTPUT', '   OutSig : Bool;', 'END_VAR',
    $secStatic,
    'BEGIN',
    '    #StepTimer[1](IN := #InSig, PT := T#2S);',
    '    #FaultTimer(IN := #InSig, PT := T#3S);',
    '    #FaultLatch := #StepTimer[1].Q OR #FaultTimer.Q;',
    '    #CurrentStation := 1;',
    '    #PrevStart := #InSig;',
    '    #StartPulse := #PrevStart;',
    '    #OutSig := #FaultLatch;')) }

# I4: full VAR_TEMP only
$jobs += @{ Name = 'ProbeI4Temp'; Text = (Scl 'ProbeI4Temp' @(
    'VAR_INPUT', '   InSig : Bool;', 'END_VAR',
    'VAR_OUTPUT', '   OutSig : Bool;', 'END_VAR',
    $secTemp,
    'BEGIN',
    '    #i := 1;',
    '    #AllHome := #InSig;',
    '    #OutSig := #AllHome;')) }

$generated = @()
foreach ($j in $jobs) {
    $srcPath = Join-Path $env:TEMP ($j.Name + '.scl')
    $status = 'gen-ok'
    try {
        [System.IO.File]::WriteAllText($srcPath, $j.Text, $utf8NoBom)
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
    Write-Output ("COMPILE state={0} errors={1}" -f $cmp.State, $cmp.ErrorCount)
    foreach ($name in $generated) {
        $mine = @($cmp.Messages | Where-Object {
            "$($_.Ancestry)/$($_.Path)" -like "*$name*" -and "$($_.State)" -eq 'Error' -and $_.Description
        })
        Write-Output ("BLOCK {0,-16} errors={1}" -f $name, $mine.Count)
        $mine | Select-Object -First 6 | ForEach-Object { Write-Output ("    " + $_.Description) }
    }
    foreach ($name in $generated) {
        try { $null = Remove-YinBlockByName -BlockName $name } catch { }
    }
}

Disconnect-YinPortal
