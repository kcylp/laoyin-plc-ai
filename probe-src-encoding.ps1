# Probe round 2: generate blocks from SCL source variants, then COMPILE once
# and attribute errors per block. Round 1 showed export is impossible because
# freshly generated blocks are inconsistent - so interface survival must be
# judged by the compiler, not by export.
# Pure ASCII on purpose (PS 5.1 GBK trap).
param([Parameter(Mandatory)][string]$EngineRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Import-Module (Join-Path $EngineRoot 'src\EngineerYin.Write.psm1') -Force
$null = Initialize-YinAssemblies
$conn = Connect-YinPortal

$cnComment = '// ' + [char]0x6CE8 + [char]0x91CA + [char]0x6D4B + [char]0x8BD5

function Build-Source([string]$name, [bool]$withComment, [bool]$crlf) {
    $lines = @(
        'FUNCTION_BLOCK "' + $name + '"'
        "{ S7_Optimized_Access := 'TRUE' }"
        'VERSION : 0.1'
        'VAR_INPUT'
        '   InSig : Bool;' + $(if ($withComment) { '   ' + $cnComment } else { '' })
        'END_VAR'
        'VAR_OUTPUT'
        '   OutSig : Bool;'
        'END_VAR'
        'BEGIN'
        '    #OutSig := #InSig;'
        'END_FUNCTION_BLOCK'
    )
    $text = [string]::Join("`n", $lines) + "`n"
    if ($crlf) { $text = $text -replace "`n", "`r`n" }
    return $text
}

$variants = @(
    @{ Name = 'ProbeV1LfNobomCn';   Crlf = $false; Bom = $false; Cn = $true  }
    @{ Name = 'ProbeV2CrlfNobomCn'; Crlf = $true;  Bom = $false; Cn = $true  }
    @{ Name = 'ProbeV3CrlfBomCn';   Crlf = $true;  Bom = $true;  Cn = $true  }
    @{ Name = 'ProbeV4LfBomCn';     Crlf = $false; Bom = $true;  Cn = $true  }
    @{ Name = 'ProbeV5CrlfBomAscii'; Crlf = $true; Bom = $true;  Cn = $false }
)

$generated = @()
foreach ($v in $variants) {
    $name = $v.Name
    $srcPath = Join-Path $env:TEMP ($name + '.scl')
    $status = 'gen-ok'
    try {
        $text = Build-Source $name $v.Cn $v.Crlf
        $enc = New-Object System.Text.UTF8Encoding($v.Bom)
        [System.IO.File]::WriteAllText($srcPath, $text, $enc)
        $null = Import-YinSourceFile -SourcePath $srcPath -Overwrite
        $generated += $name
    } catch {
        $status = 'gen-fail: ' + $_.Exception.Message
    } finally {
        Remove-Item $srcPath -Force -ErrorAction SilentlyContinue
    }
    Write-Output ("GEN {0}  crlf={1} bom={2} cn={3}  -> {4}" -f $name, $v.Crlf, $v.Bom, $v.Cn, $status)
}

if ($generated.Count -gt 0) {
    $cmp = Invoke-YinCompile
    Write-Output ("COMPILE state={0} errors={1} warnings={2}" -f $cmp.State, $cmp.ErrorCount, $cmp.WarningCount)
    foreach ($name in $generated) {
        $mine = @($cmp.Messages | Where-Object {
            "$($_.Ancestry)/$($_.Path)" -like "*$name*" -and "$($_.State)" -eq 'Error' -and $_.Description
        })
        Write-Output ("BLOCK {0}  errors={1}" -f $name, $mine.Count)
        $mine | Select-Object -First 4 | ForEach-Object { Write-Output ("    " + $_.Description) }
    }
    foreach ($name in $generated) {
        try { $null = Remove-YinBlockByName -BlockName $name } catch { }
    }
}

Disconnect-YinPortal
