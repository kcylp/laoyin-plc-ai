# Probe: generic IEC_COUNTER as VAR_IN_OUT parameter.
# Static declaration of IEC_COUNTER fails ("Invalid function name") because the
# generic IEC types are abstract. Their documented purpose is InOut parameters:
# a generic FB that accepts ANY concrete counter passed by the caller.
# A: generic FB, Q bound inside the call with =>
# B: generic FB, post-access #Cnt.Q (does it work for InOut?)
# C: caller FB passes its CTU_INT multi-instance into the generic FB (end-to-end)
# Pure ASCII (PS 5.1 GBK trap).
param([Parameter(Mandatory)][string]$EngineRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Import-Module (Join-Path $EngineRoot 'src\EngineerYin.Write.psm1') -Force
$null = Initialize-YinAssemblies
$conn = Connect-YinPortal
$utf8Bom = New-Object System.Text.UTF8Encoding($true)

$srcA = @'
FUNCTION_BLOCK "ProbeGenCntArrow"
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1
VAR_INPUT
   Pulse : Bool;
   Reset : Bool;
   Preset : Int;
END_VAR
VAR_OUTPUT
   Done : Bool;
   Value : Int;
END_VAR
VAR_IN_OUT
   Cnt : IEC_COUNTER;
END_VAR
BEGIN
    #Cnt(CU := #Pulse, R := #Reset, PV := #Preset, Q => #Done);
    #Value := #Cnt.CV;
END_FUNCTION_BLOCK
'@

$srcB = @'
FUNCTION_BLOCK "ProbeGenCntPost"
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1
VAR_INPUT
   Pulse : Bool;
   Reset : Bool;
   Preset : Int;
END_VAR
VAR_OUTPUT
   Done : Bool;
   Value : Int;
END_VAR
VAR_IN_OUT
   Cnt : IEC_COUNTER;
END_VAR
BEGIN
    #Cnt(CU := #Pulse, R := #Reset, PV := #Preset);
    #Done := #Cnt.Q;
    #Value := #Cnt.CV;
END_FUNCTION_BLOCK
'@

# Caller: holds the concrete CTU_INT and feeds it into the generic FB.
# Generated in the same source AFTER the callee so the type resolves.
$srcC = @'
FUNCTION_BLOCK "ProbeGenCntCallee"
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1
VAR_INPUT
   Pulse : Bool;
   Reset : Bool;
   Preset : Int;
END_VAR
VAR_OUTPUT
   Done : Bool;
   Value : Int;
END_VAR
VAR_IN_OUT
   Cnt : IEC_COUNTER;
END_VAR
BEGIN
    #Cnt(CU := #Pulse, R := #Reset, PV := #Preset, Q => #Done);
    #Value := #Cnt.CV;
END_FUNCTION_BLOCK

FUNCTION_BLOCK "ProbeCntCaller"
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1
VAR_INPUT
   Pulse : Bool;
   Reset : Bool;
END_VAR
VAR_OUTPUT
   Done : Bool;
   Value : Int;
END_VAR
VAR
   MyCnt : CTU_INT;
   Worker : "ProbeGenCntCallee";
END_VAR
BEGIN
    #Worker(Pulse := #Pulse, Reset := #Reset, Preset := 10, Cnt := #MyCnt);
    #Done := #Worker.Done;
    #Value := #Worker.Value;
END_FUNCTION_BLOCK
'@

$jobs = @(
    @{ Name = 'ProbeGenCntArrow'; Text = $srcA; Expect = @('ProbeGenCntArrow') }
    @{ Name = 'ProbeGenCntPost';  Text = $srcB; Expect = @('ProbeGenCntPost') }
    @{ Name = 'ProbeCntChain';    Text = $srcC; Expect = @('ProbeGenCntCallee', 'ProbeCntCaller') }
)

$allNames = @()
foreach ($j in $jobs) {
    $srcPath = Join-Path $env:TEMP ($j.Name + '.scl')
    $status = 'gen-ok'
    try {
        [System.IO.File]::WriteAllText($srcPath, $j.Text, $utf8Bom)
        $null = Import-YinSourceFile -SourcePath $srcPath -Overwrite
        $allNames += $j.Expect
    } catch {
        $status = 'gen-fail: ' + $_.Exception.Message
    } finally {
        Remove-Item $srcPath -Force -ErrorAction SilentlyContinue
    }
    Write-Output ("GEN {0,-18} -> {1}" -f $j.Name, $status)
}

$cmp = Invoke-YinCompile
Write-Output ("COMPILE state={0} errors={1}" -f $cmp.State, $cmp.ErrorCount)
foreach ($name in $allNames) {
    $mine = @($cmp.Messages | Where-Object {
        "$($_.Ancestry)/$($_.Path)" -like "*$name*" -and "$($_.State)" -eq 'Error' -and $_.Description
    })
    Write-Output ("BLOCK {0,-18} errors={1}" -f $name, $mine.Count)
    $mine | Select-Object -First 4 | ForEach-Object { Write-Output ("    " + $_.Description) }
}
foreach ($name in $allNames) {
    try { $null = Remove-YinBlockByName -BlockName $name } catch { }
}
Disconnect-YinPortal
