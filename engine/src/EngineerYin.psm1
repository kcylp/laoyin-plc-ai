# ============================================================
#  Engineer Yin  -  TIA Portal Openness autonomous engine (any version)
#  Stack: .NET Framework 4.8 + Siemens official Openness API + official XSD
#  Fully self-derived from public sources. No third-party paid component.
# ============================================================

# Discover installed TIA version instead of hardcoding V21
. (Join-Path $PSScriptRoot 'YinTiaDiscovery.ps1')

$script:Net48 = ''
$script:SchemaDir = Join-Path (Split-Path $PSScriptRoot -Parent) "schemas"
$script:Resolving = @{}

# ---- internal: resolve the net48 dir once, cached ----
function Get-YinNet48 {
    if (-not $script:Net48) {
        $inst = Get-YinTiaInstall
        $script:Net48 = $inst.Net48Dir
        Write-Verbose "TIA $($inst.EngineeringVersion) -> $($script:Net48)"
    }
    return $script:Net48
}

# ---- Capability 1: V21 split-assembly loader (recursion-guarded) ----
function Initialize-YinOpenness {
    [CmdletBinding()]
    param()
    $handler = [ResolveEventHandler]{
        param($s, $e)
        $name = ($e.Name -split ',')[0]
        $loaded = [AppDomain]::CurrentDomain.GetAssemblies() |
            Where-Object { $_.GetName().Name -eq $name } | Select-Object -First 1
        if ($loaded) { return $loaded }
        if ($script:Resolving.ContainsKey($name)) { return $null }
        $script:Resolving[$name] = $true
        $dll = Join-Path (Get-YinNet48) "$name.dll"
        if (Test-Path $dll) { return [Reflection.Assembly]::LoadFrom($dll) }
        return $null
    }
    [AppDomain]::CurrentDomain.add_AssemblyResolve($handler)
    $net48 = Get-YinNet48
    $asm = [Reflection.Assembly]::LoadFrom((Join-Path $net48 "Siemens.Engineering.Base.dll"))
    $tp = $asm.GetType("Siemens.Engineering.TiaPortal")
    if (-not $tp) { throw "TiaPortal type not found -- V21 Openness load failed" }
    Write-Verbose "Openness loaded: $($asm.GetName().Name) v$($asm.GetName().Version)"
    return $true
}

# ---- Capability 2: local XSD validator (official schema, prove-before-import) ----
function Test-YinFlgNet {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$XmlPath,
        [string]$SchemaFile = "SW.PlcBlocks.LADFBD_v5.xsd"
    )
    $errors = New-Object System.Collections.ArrayList
    # Shared validation event handler for both schema load and XML validate
    $handler = [System.Xml.Schema.ValidationEventHandler]{
        param($s, $e)
        [void]$errors.Add([pscustomobject]@{
            Severity = $e.Severity
            Line     = $e.Exception.LineNumber
            Pos      = $e.Exception.LinePosition
            Message  = $e.Message
        })
    }
    # Official FlgNet schema has no targetNamespace. Load only the root schema;
    # its xs:include chain pulls CompileUnitCommon -> Access automatically.
    # Use XmlSchema.Read to sidestep the null-namespace overload ambiguity of Schemas.Add.
    $root = Join-Path $script:SchemaDir $SchemaFile
    $rSet = New-Object System.Xml.Schema.XmlSchemaSet
    $rSet.XmlResolver = New-Object System.Xml.XmlUrlResolver
    $schemaReader = [System.Xml.XmlReader]::Create($root)
    $schemaObj = [System.Xml.Schema.XmlSchema]::Read($schemaReader, $handler)
    [void]$rSet.Add($schemaObj)
    $rSet.Compile()
    $schemaReader.Close()

    $settings = New-Object System.Xml.XmlReaderSettings
    $settings.ValidationType = [System.Xml.ValidationType]::Schema
    [void]$settings.Schemas.Add($rSet)
    $settings.add_ValidationEventHandler($handler)
    try {
        $reader = [System.Xml.XmlReader]::Create($XmlPath, $settings)
        while ($reader.Read()) {}
        $reader.Close()
    } catch {
        [void]$errors.Add([pscustomobject]@{ Severity='Fatal'; Line=0; Pos=0; Message=$_.Exception.Message })
    }
    return [pscustomobject]@{
        Valid  = ($errors.Count -eq 0)
        Errors = $errors
        Xml    = $XmlPath
    }
}

Export-ModuleMember -Function Initialize-YinOpenness, Test-YinFlgNet
