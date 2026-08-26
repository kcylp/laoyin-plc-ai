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
        $net48Dir   = ''      # resolved public API folder
        $portalRoot = ''
        $pathSource = ''
        $opennessDll = ''
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

                # Siemens records the authoritative assembly path either on the
                # assembly node itself or on a net48/net47 child node.
                $propertyNodes = @($asmNode)
                $propertyNodes += @(Get-ChildItem $asmNode.PSPath -ErrorAction SilentlyContinue |
                    Where-Object { $_.PSChildName -match '^net4[578]$' })
                foreach ($propertyNode in $propertyNodes) {
                    $dllProps = Get-ItemProperty $propertyNode.PSPath -ErrorAction SilentlyContinue
                    if (-not $dllProps) { continue }
                    foreach ($valueName in @('Siemens.Engineering.Base', 'Siemens.Engineering')) {
                        $candidateDll = [string]$dllProps.$valueName
                        if ($candidateDll -and (Test-Path -LiteralPath $candidateDll -PathType Leaf)) {
                            $opennessDll = $candidateDll
                            $net48Dir = Split-Path -Parent $candidateDll
                            $portalRoot = $candidateDll -replace '(?i)[\\/]PublicAPI[\\/]V?\d+(?:\.\d+\.\d+\.\d+)?[\\/]net4[578][\\/][^\\/]+\.dll$', ''
                            $pathSource = 'registry'
                            break
                        }
                    }
                    if ($opennessDll) { break }
                }
            }
        }

        # Last-resort compatibility fallback for older installations that do not
        # record assembly values. Mark it so diagnostics never report it as fact.
        if (-not $net48Dir -and $engVersion) {
            $base = Join-Path $env:ProgramFiles "Siemens\Automation\Portal $engVersion\PublicAPI\$engVersion"
            foreach ($sub in @('net48', 'net47', '')) {
                $cand = if ($sub) { Join-Path $base $sub } else { $base }
                if ($cand -and (Test-Path $cand)) {
                    $net48Dir = $cand
                    $portalRoot = Join-Path $env:ProgramFiles "Siemens\Automation\Portal $engVersion"
                    $pathSource = 'guessed'
                    $opennessDll = Join-Path $net48Dir 'Siemens.Engineering.Base.dll'
                    break
                }
            }
        }

        $major = 0
        if ($engVersion -match 'V(\d+)') { $major = [int]$Matches[1] }

        $found += [pscustomobject]@{
            Major              = $major
            EngineeringVersion = $engVersion      # "V21"
            AssemblyVersion    = $asmVersion      # "21.0.0.0"
            RegistryVersion    = $assemblyVer     # "21.0"
            Net48Dir           = $net48Dir
            PublicApiDir       = $net48Dir
            PortalRoot         = $portalRoot
            PathSource         = $pathSource
            OpennessDll        = $opennessDll
            DllsPresent        = [pscustomobject]@{
                EngineeringBase = [bool]($net48Dir -and (Test-Path -LiteralPath (Join-Path $net48Dir 'Siemens.Engineering.Base.dll') -PathType Leaf))
                Engineering     = [bool]($net48Dir -and (Test-Path -LiteralPath (Join-Path $net48Dir 'Siemens.Engineering.dll') -PathType Leaf))
            }
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
        Major              = $best.Major
        AssemblyVersion    = $best.AssemblyVersion
        Net48Dir           = $best.Net48Dir
        PublicApiDir       = $best.PublicApiDir
        PortalRoot         = $best.PortalRoot
        PathSource         = $best.PathSource
        DllsPresent        = $best.DllsPresent
        OpennessDll        = $best.OpennessDll
        AllInstalled       = @($all | ForEach-Object { $_.EngineeringVersion } | Where-Object { $_ })
    }
}
