$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot\EngineerYin.psm1" -Force

$samples = Split-Path $PSScriptRoot -Parent | Join-Path -ChildPath "samples"

foreach ($f in @("good_startstop.xml", "bad_missing_uid.xml")) {
    $path = Join-Path $samples $f
    Write-Output "======== $f ========"
    $r = Test-YinFlgNet -XmlPath $path
    if ($r.Valid) {
        Write-Output "  [VALID] passed official XSD - safe to import"
    } else {
        Write-Output "  [INVALID] found $($r.Errors.Count) problem(s):"
        $r.Errors | ForEach-Object { Write-Output ("    L{0}:{1}  {2}" -f $_.Line, $_.Pos, $_.Message) }
    }
    Write-Output ""
}
