# Probe round 3: bisect WHICH construct makes ExternalSources generation drop
# the block interface ("Tag #x not defined" for every VAR member).
# Round 2 proved a minimal SCL FB survives with ANY encoding/line-ending/comment
# combination, so the killer is inside the stress sources themselves.
# Blocks: full stress SCL + full stress STL (reproduce), then one construct
# per block (VAR_TEMP / Bool array / TON_TIME / TON_TIME array / DInt / CASE /
# FOR) plus a minimal STL block.
# Pure ASCII (PS 5.1 GBK trap). Full sources live in UTF-8 data files.
param([Parameter(Mandatory)][string]$EngineRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Import-Module (Join-Path $EngineRoot 'src\EngineerYin.Write.psm1') -Force
$null = Initialize-YinAssemblies
$conn = Connect-YinPortal

$dataDir = Join-Path (Split-Path $EngineRoot -Parent) 'work\probe'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Scl([string]$name, [string[]]$lines) {
    return ([string]::Join("`n", (@('FUNCTION_BLOCK "' + $name + '"', "{ S7_Optimized_Access := 'TRUE' }", 'VERSION : 0.1') + $lines + @('END_FUNCTION_BLOCK'))) + "`n")
}

$jobs = @()

# 1) full stress sources, byte-for-byte what production writes (UTF-8 no BOM, LF)
$jobs += @{ Name = 'Stress_ConveyorFSM'; Kind = 'scl'; Text = [System.IO.File]::ReadAllText((Join-Path $dataDir 'Stress_ConveyorFSM.scl'), [System.Text.Encoding]::UTF8) }
$jobs += @{ Name = 'Stress_StlLogic';    Kind = 'stl'; Text = [System.IO.File]::ReadAllText((Join-Path $dataDir 'Stress_StlLogic.awl'), [System.Text.Encoding]::UTF8) }

# 2) single-construct SCL blocks
$jobs += @{ Name = 'ProbeSclTemp'; Kind = 'scl'; Text = (Scl 'ProbeSclTemp' @(
    'VAR_INPUT', '   InSig : Bool;', 'END_VAR',
    'VAR_OUTPUT', '   OutSig : Bool;', 'END_VAR',
    'VAR_TEMP', '   i : Int;', '   Flag : Bool;', 'END_VAR',
    'BEGIN', '    #Flag := #InSig;', '    #i := 1;', '    #OutSig := #Flag;')) }

$jobs += @{ Name = 'ProbeSclArrIn'; Kind = 'scl'; Text = (Scl 'ProbeSclArrIn' @(
    'VAR_INPUT', '   StationSensor : Array[1..3] of Bool;', 'END_VAR',
    'VAR_OUTPUT', '   OutSig : Bool;', 'END_VAR',
    'BEGIN', '    #OutSig := #StationSensor[1] AND #StationSensor[2];')) }

$jobs += @{ Name = 'ProbeSclArrOut'; Kind = 'scl'; Text = (Scl 'ProbeSclArrOut' @(
    'VAR_OUTPUT', '   MotorRun : Array[1..3] of Bool;', 'END_VAR',
    'BEGIN', '    #MotorRun[1] := TRUE;', '    #MotorRun[2] := FALSE;')) }

$jobs += @{ Name = 'ProbeSclTon'; Kind = 'scl'; Text = (Scl 'ProbeSclTon' @(
    'VAR_INPUT', '   InSig : Bool;', 'END_VAR',
    'VAR_OUTPUT', '   OutSig : Bool;', 'END_VAR',
    'VAR', '   T1 : TON_TIME;', 'END_VAR',
    'BEGIN', '    #T1(IN := #InSig, PT := T#2S);', '    #OutSig := #T1.Q;')) }

$jobs += @{ Name = 'ProbeSclTonArr'; Kind = 'scl'; Text = (Scl 'ProbeSclTonArr' @(
    'VAR_INPUT', '   InSig : Bool;', 'END_VAR',
    'VAR_OUTPUT', '   OutSig : Bool;', 'END_VAR',
    'VAR', '   TA : Array[1..3] of TON_TIME;', 'END_VAR',
    'BEGIN', '    #TA[1](IN := #InSig, PT := T#2S);', '    #OutSig := #TA[1].Q;')) }

$jobs += @{ Name = 'ProbeSclDint'; Kind = 'scl'; Text = (Scl 'ProbeSclDint' @(
    'VAR_OUTPUT', '   Cnt : DInt;', 'END_VAR',
    'BEGIN', '    #Cnt := #Cnt + 1;')) }

$jobs += @{ Name = 'ProbeSclCase'; Kind = 'scl'; Text = (Scl 'ProbeSclCase' @(
    'VAR_OUTPUT', '   OutSig : Bool;', 'END_VAR',
    'VAR', '   State : Int;', 'END_VAR',
    'BEGIN',
    '    CASE #State OF',
    '        0: #OutSig := FALSE;',
    '        1: #OutSig := TRUE;',
    '    ELSE',
    '        #OutSig := FALSE;',
    '    END_CASE;')) }

$jobs += @{ Name = 'ProbeSclFor'; Kind = 'scl'; Text = (Scl 'ProbeSclFor' @(
    'VAR_INPUT', '   StationSensor : Array[1..3] of Bool;', 'END_VAR',
    'VAR_OUTPUT', '   OutSig : Bool;', 'END_VAR',
    'VAR_TEMP', '   i : Int;', 'END_VAR',
    'BEGIN',
    '    #OutSig := TRUE;',
    '    FOR #i := 1 TO 3 DO',
    '        IF NOT #StationSensor[#i] THEN',
    '            #OutSig := FALSE;',
    '        END_IF;',
    '    END_FOR;')) }

# 3) minimal STL
$jobs += @{ Name = 'ProbeStlMin'; Kind = 'stl'; Text = (([string]::Join("`n", @(
    'FUNCTION_BLOCK "ProbeStlMin"',
    'VERSION : 0.1',
    'VAR_INPUT', '  InSig : Bool;', 'END_VAR',
    'VAR_OUTPUT', '  OutSig : Bool;', 'END_VAR',
    'BEGIN',
    'NETWORK',
    '      A     #InSig;',
    '      =     #OutSig;',
    'END_FUNCTION_BLOCK'))) + "`n") }

$generated = @()
foreach ($j in $jobs) {
    $ext = if ($j.Kind -eq 'scl') { '.scl' } else { '.awl' }
    $srcPath = Join-Path $env:TEMP ($j.Name + $ext)
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
    Write-Output ("GEN {0,-20} -> {1}" -f $j.Name, $status)
}

if ($generated.Count -gt 0) {
    $cmp = Invoke-YinCompile
    Write-Output ("COMPILE state={0} errors={1} warnings={2}" -f $cmp.State, $cmp.ErrorCount, $cmp.WarningCount)
    foreach ($name in $generated) {
        $mine = @($cmp.Messages | Where-Object {
            "$($_.Ancestry)/$($_.Path)" -like "*$name*" -and "$($_.State)" -eq 'Error' -and $_.Description
        })
        Write-Output ("BLOCK {0,-20} errors={1}" -f $name, $mine.Count)
        $mine | Select-Object -First 5 | ForEach-Object { Write-Output ("    " + $_.Description) }
    }
    # cleanup only the single-construct probes; keep the two stress blocks as-is
    foreach ($name in ($generated | Where-Object { $_ -like 'Probe*' })) {
        try { $null = Remove-YinBlockByName -BlockName $name } catch { }
    }
}

Disconnect-YinPortal
