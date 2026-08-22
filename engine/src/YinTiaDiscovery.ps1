# ============================================================
#  Engineer Yin - TIA Portal installation discovery
#  Reads the Openness registry hive to find every installed TIA
#  version and the net48 public-API directory. No hardcoded V21.
#  Pure ASCII (PS 5.1 GBK trap - see HANDOFF doc).
# ============================================================

$script:OpennessRegRoot = 'HKLM:\SOFTWARE\Siemens\Automation\Openness'

# ---- Discover every installed TIA Openness version ----
function Get-YinTiaInstalls {
    [CmdletBinding()]
    param()

    $found = @()
    if (-not (Test-Path $script:OpennessRegRoot)) {
        return $found
    }

    foreach ($verNode in (Get-ChildItem $script:OpennessRegRoot -ErrorAction SilentlyContinue |
            Where-Object { $_.PSChildName -match '^\d+\.\d+$' })) {

        $engVersion = ''      # e.g. "V21"
        $asmVersion = ''      # e.g. "21.0.0.0"
        $net48Dir   = ''      # resolved net48 folder
        $assemblyVer = $verNode.PSChildName  # e.g. "21.0"

        $pubApi = Join-Path $verNode.PSPath 'PublicAPI'
        if (Test-Path $pubApi) {
            # e.g. PublicAPI\21.0.0.0
            $asmNode = Get-ChildItem $pubApi -ErrorAction SilentlyContinue |
                Sort-Object { [version]$_.PSChildName } -Descending |
                Select-Object -First 1
            if ($asmNode) {
                $asmVersion = $asmNode.PSChildName
                $props = Get-ItemProperty $asmNode.PSPath -ErrorAction SilentlyContinue
                if ($props) {
                    $engVersion = $props.EngineeringVersion
                }
            }
        }

        # net48 folder = C:\Program Files\Siemens\Automation\Portal <EngVer>\PublicAPI\<EngVer>\net48
        if ($engVersion) {
            $base = Join-Path $env:ProgramFiles "Siemens\Automation\Portal $engVersion\PublicAPI\$engVersion"
            foreach ($sub in @('net48', 'net47', '')) {
                $cand = if ($sub) { Join-Path $base $sub } else { $base }
                if ($cand -and (Test-Path $cand)) {
                    $net48Dir = $cand
                    break
                }
            }
        }

        $found += [pscustomobject]@{
            EngineeringVersion = $engVersion      # "V21"
            AssemblyVersion    = $asmVersion      # "21.0.0.0"
            RegistryVersion    = $assemblyVer     # "21.0"
            Net48Dir           = $net48Dir
            OpennessDll        = Join-Path $net48Dir 'Siemens.Engineering.Base.dll'
        }
    }

    return $found
}

# ---- Pick the best (highest) install for the current session ----
function Get-YinTiaInstall {
    [CmdletBinding()]
    param()

    $all = @(Get-YinTiaInstalls)
    if ($all.Count -eq 0) {
        throw "No TIA Portal Openness found. Install TIA Portal with the Openness option, or check HKLM:\SOFTWARE\Siemens\Automation\Openness"
    }

    # highest EngineeringVersion wins; sort descending by the numeric suffix
    $best = $all | Sort-Object {
        if ($_.EngineeringVersion -match 'V(\d+)') { [int]$Matches[1] } else { 0 }
    } -Descending | Select-Object -First 1

    if (-not $best.Net48Dir -or -not (Test-Path $best.Net48Dir)) {
        throw "TIA $($best.EngineeringVersion) found in registry but net48 dir missing: $($best.Net48Dir)"
    }

    return [pscustomobject]@{
        EngineeringVersion = $best.EngineeringVersion
        AssemblyVersion    = $best.AssemblyVersion
        Net48Dir           = $best.Net48Dir
        OpennessDll        = $best.OpennessDll
        AllInstalled       = @($all | ForEach-Object { $_.EngineeringVersion } | Where-Object { $_ })
    }
}
