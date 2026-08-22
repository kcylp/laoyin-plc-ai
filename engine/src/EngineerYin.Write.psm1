# ============================================================
#  Engineer Yin - TIA Portal project WRITE module (any version)
#  Capabilities:
#    1. Attach to a running TIA Portal instance and its open project
#    2. Full recursive inventory of existing FC / FB / DB / OB blocks
#    3. Collision-free name and number allocation
#    4. XSD-validated block XML import (never import invalid XML)
#    5. PLC tag table creation (English symbol names, Chinese comments)
#    6. Compile after write and return structured diagnostics
#  HARD CONSTRAINT: split assemblies overflow the stack under broad
#  reflection. Resolve ONLY the exact types needed, by full name.
#  NOTE: keep every comment in this file ASCII - PS 5.1 on a Chinese
#  locale misreads UTF-8 Chinese in .psm1 and corrupts brace parsing.
# ============================================================

# version discovery (registry-based, no hardcoded V21)
. (Join-Path $PSScriptRoot 'YinTiaDiscovery.ps1')

$script:Net48 = ''
$script:YinRoot = Split-Path $PSScriptRoot -Parent
$script:Portal = $null
$script:Project = $null

# ---- internal: resolve the net48 dir once, cached ----
function Get-YinNet48 {
    if (-not $script:Net48) {
        $inst = Get-YinTiaInstall
        $script:Net48 = $inst.Net48Dir
    }
    return $script:Net48
}

# ---- internal: resolve one type by full name across loaded assemblies ----
function Get-YinType {
    param([Parameter(Mandatory)][string]$FullName)
    foreach ($asm in [AppDomain]::CurrentDomain.GetAssemblies()) {
        $t = $asm.GetType($FullName)
        if ($t) { return $t }
    }
    # not yet loaded - pull the two assemblies that hold the public API
    foreach ($dll in @('Siemens.Engineering.Base.dll', 'Siemens.Engineering.Step7.dll')) {
        $path = Join-Path (Get-YinNet48) $dll
        if (Test-Path $path) {
            $asm = [Reflection.Assembly]::LoadFrom($path)
            $t = $asm.GetType($FullName)
            if ($t) { return $t }
        }
    }
    throw "Type not found: $FullName"
}

# ---- internal: eagerly preload every net48 assembly ----
# Attach() resolves dozens of dependencies. Letting the AssemblyResolve
# handler load them on demand nests deeply enough to overflow the stack
# (uncatchable). Preloading makes the handler hit its "already loaded"
# fast path instead, so resolution never nests.
function Initialize-YinAssemblies {
    [CmdletBinding()]
    param()

    # Install the C# resolver INSTEAD of the ScriptBlock one. Do not call
    # Initialize-YinOpenness here - its PowerShell handler is what overflows.
    . (Join-Path $PSScriptRoot 'YinResolver.ps1')
    [EngineerYin.NativeResolver]::Install((Get-YinNet48))
    $loaded = [EngineerYin.NativeResolver]::PreloadAll()

    # Touch the entry type so a bad path fails loudly right here.
    $null = Get-YinType 'Siemens.Engineering.TiaPortal'
    return $loaded
}

# ---- Capability 1: attach to a running TIA Portal instance ----
function Connect-YinPortal {
    [CmdletBinding()]
    param([int]$ProcessId = 0)

    $null = Initialize-YinAssemblies

    $tpType = Get-YinType 'Siemens.Engineering.TiaPortal'
    $procs = @($tpType::GetProcesses())
    if ($procs.Count -eq 0) {
        throw "No running TIA Portal instance. Open TIA Portal V21 and open a project first."
    }

    if ($ProcessId -gt 0) {
        $targets = $procs | Where-Object { $_.Id -eq $ProcessId }
    } else {
        $targets = $procs
    }
    $targets = [array]$targets
    if ($targets.Count -eq 0) { throw "TIA Portal process id $ProcessId not found." }

    foreach ($candidate in $targets) {
        $candidatePortal = $null
        try {
            $candidatePortal = $candidate.Attach()
            $candidateProject = $candidatePortal.Projects | Select-Object -First 1
            if ($candidateProject) {
                $script:Portal = $candidatePortal
                $script:Project = $candidateProject
                $target = $candidate
                break
            }
        } catch {
            if ($ProcessId -gt 0) { throw }
        }
        if ($candidatePortal) { try { $candidatePortal.Dispose() } catch { } }
    }
    if (-not $script:Project) {
        throw "TIA Portal is running but no project is open. Open a project first."
    }

    return [pscustomobject]@{
        ProcessId   = $target.Id
        ProjectName = $script:Project.Name
        ProjectPath = "$($script:Project.Path)"
        Devices     = @($script:Project.Devices).Count
    }
}

function Disconnect-YinPortal {
    if ($script:Portal) { try { $script:Portal.Dispose() } catch { } }
    $script:Portal = $null
    $script:Project = $null
}

function Test-YinPortalConnection {
    [CmdletBinding()]
    param()

    if (-not $script:Portal -or -not $script:Project) { return $false }
    try {
        $null = $script:Project.Name
        $null = @($script:Project.Devices).Count
        return $true
    } catch {
        return $false
    }
}

# ---- internal: call the generic GetService<T>() through reflection ----
# PowerShell's GetService[T]() syntax is resolved at parse time, which fails
# because the V21 assemblies only load at runtime. Bind the generic here.
function Invoke-YinGetService {
    param(
        [Parameter(Mandatory)]$Target,
        [Parameter(Mandatory)][Type]$ServiceType
    )
    $method = $Target.GetType().GetMethods() |
        Where-Object { $_.Name -eq 'GetService' -and $_.IsGenericMethod } |
        Select-Object -First 1
    if (-not $method) { return $null }
    try { return $method.MakeGenericMethod($ServiceType).Invoke($Target, @()) } catch { return $null }
}

# ---- internal: find the PlcSoftware of the first S7 CPU ----
function Get-YinPlcSoftware {
    if (-not $script:Project) { throw "Not connected. Call Connect-YinPortal first." }
    $swType = Get-YinType 'Siemens.Engineering.SW.PlcSoftware'

    # GetService<T>() is generic; the type is only loadable at runtime, so
    # bind it via reflection instead of PowerShell's parse-time [T] syntax.
    $containerType = Get-YinType 'Siemens.Engineering.HW.Features.SoftwareContainer'

    foreach ($device in $script:Project.Devices) {
        foreach ($item in $device.DeviceItems) {
            # DeviceItems nest one level deep on most CPU racks
            foreach ($sub in @($item) + @($item.DeviceItems)) {
                if (-not $sub) { continue }
                $provider = Invoke-YinGetService -Target $sub -ServiceType $containerType
                if ($provider -and $provider.Software -and $swType.IsInstanceOfType($provider.Software)) {
                    return $provider.Software
                }
            }
        }
    }
    throw "No PLC software found in the open project. Is a S7-1200/1500 CPU configured?"
}

# ---- internal: walk a PlcBlockGroup tree, collecting every block ----
function Get-YinBlocksRecursive {
    param($Group, [string]$PathPrefix = '')

    $out = New-Object System.Collections.ArrayList
    foreach ($b in $Group.Blocks) {
        # ProgrammingLanguage is absent on DB types - guard every access
        $lang = ''
        try { $lang = "$($b.ProgrammingLanguage)" } catch { }
        [void]$out.Add([pscustomobject]@{
            Name     = $b.Name
            Number   = $b.Number
            Type     = $b.GetType().Name
            Language = $lang
            Path     = if ($PathPrefix) { "$PathPrefix/$($b.Name)" } else { $b.Name }
        })
    }
    foreach ($g in $Group.Groups) {
        $childPrefix = if ($PathPrefix) { "$PathPrefix/$($g.Name)" } else { $g.Name }
        foreach ($item in (Get-YinBlocksRecursive -Group $g -PathPrefix $childPrefix)) {
            [void]$out.Add($item)
        }
    }
    return $out
}

# ---- internal: collect real block objects and full group paths ----
function Find-YinBlockMatchesRecursive {
    param(
        [Parameter(Mandatory)]$Group,
        [Parameter(Mandatory)][string]$BlockName,
        [string]$PathPrefix = ''
    )

    $matches = New-Object System.Collections.ArrayList
    foreach ($block in @($Group.Blocks)) {
        if ($block -and $block.Name -eq $BlockName) {
            [void]$matches.Add([pscustomobject]@{
                Block = $block
                Path  = if ($PathPrefix) { "$PathPrefix/$($block.Name)" } else { $block.Name }
            })
        }
    }
    foreach ($child in @($Group.Groups)) {
        if (-not $child) { continue }
        $childPath = if ($PathPrefix) { "$PathPrefix/$($child.Name)" } else { $child.Name }
        foreach ($match in (Find-YinBlockMatchesRecursive -Group $child -BlockName $BlockName -PathPrefix $childPath)) {
            [void]$matches.Add($match)
        }
    }
    return $matches
}

# ---- internal: resolve a unique block by name or full path ----
function Resolve-YinBlockForExport {
    param(
        [Parameter(Mandatory)]$Group,
        [Parameter(Mandatory)][string]$BlockName,
        [string]$BlockPath = ''
    )

    $matches = @(Find-YinBlockMatchesRecursive -Group $Group -BlockName $BlockName)
    if ($BlockPath) {
        $matches = @($matches | Where-Object { $_.Path -eq $BlockPath })
    }
    if ($matches.Count -eq 0) {
        throw "Block '$BlockName' not found."
    }
    if ($matches.Count -gt 1) {
        $paths = ($matches | ForEach-Object { $_.Path }) -join ', '
        throw "Block '$BlockName' is ambiguous. Supply -BlockPath. Candidates: $paths"
    }
    return $matches[0]
}

# ---- Capability 2: full block inventory of the open project ----
function Get-YinBlockInventory {
    [CmdletBinding()]
    param()

    $plc = Get-YinPlcSoftware
    $blocks = @(Get-YinBlocksRecursive -Group $plc.BlockGroup)

    return [pscustomobject]@{
        PlcName = $plc.Name
        Count   = $blocks.Count
        Blocks  = $blocks
        Names   = @($blocks | ForEach-Object { $_.Name })
        FcNumbers = @($blocks | Where-Object { $_.Type -eq 'FC' } | ForEach-Object { $_.Number })
        FbNumbers = @($blocks | Where-Object { $_.Type -eq 'FB' } | ForEach-Object { $_.Number })
        DbNumbers = @($blocks | Where-Object { $_.Type -match 'DB$' } | ForEach-Object { $_.Number })
    }
}

# ---- TIA block rules, enforced structurally (not left to the caller) ----
#  FC  : stateless. No Static area, no instance DB - EVER. Temp vars only.
#        Any number is fine (FC1, FC10, FC800). Cross-cycle state must come
#        in as a parameter or live in a global DB.
#  FB  : stateful. Static area persists across calls, so it REQUIRES instance
#        data - either its own instance DB, or a multi-instance slot inside
#        another FB's Static area (which consumes no DB number).
#        Timers/counters inside an FB live in that instance data.
#  GlobalDB   : standalone data, belongs to no FB. Recipes, parameters, HMI.
#  InstanceDB : structure is generated from an FB interface. It can NEVER
#               exist on its own - it must name its parent FB.
#  OB  : low numbers are reserved by the system (10-17 time, 20-23 delay,
#        30-38 cyclic, 80-87 fault, 121-122 error). User OBs start at 123.
function Assert-YinBlockRules {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('FC','FB','GlobalDB','InstanceDB','OB')][string]$BlockType,
        [switch]$WantsInstanceDb,
        [string]$ParentFb,
        [switch]$MultiInstance
    )

    switch ($BlockType) {
        'FC' {
            if ($WantsInstanceDb) {
                throw "Rule violation: FC is stateless and must NOT have an instance DB. Use an FB if cross-cycle state is needed, or pass state in as a parameter."
            }
            if ($ParentFb) {
                throw "Rule violation: FC has no parent FB - only an instance DB does."
            }
        }
        'FB' {
            if ($MultiInstance -and $WantsInstanceDb) {
                throw "Rule violation: a multi-instance FB lives in the parent FB's Static area and must NOT also get its own instance DB."
            }
            if (-not $MultiInstance -and -not $WantsInstanceDb) {
                # Not fatal, but the caller is almost certainly wrong.
                Write-Warning "FB '$BlockType' is stateful: it needs either an instance DB or a multi-instance slot. Continuing without one."
            }
        }
        'InstanceDB' {
            if (-not $ParentFb) {
                throw "Rule violation: an instance DB is generated from an FB interface and cannot stand alone. Supply -ParentFb."
            }
        }
        'GlobalDB' {
            if ($ParentFb) {
                throw "Rule violation: a global DB belongs to no FB. Use InstanceDB with -ParentFb for instance data."
            }
        }
    }
    return $true
}

# ---- Capability 3: collision-free name and number allocation ----
# HARD REQUIREMENT: a new block must never collide with an existing
# FC / FB / DB / OB, neither by name nor by number.
function New-YinSafeBlockName {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('FC','FB','GlobalDB','InstanceDB','OB')][string]$BlockType,
        [Parameter(Mandatory)][string]$DesiredName,
        [int]$MinNumber = 0,
        $Inventory = $null,
        [switch]$WantsInstanceDb,
        [string]$ParentFb,
        [switch]$MultiInstance
    )

    # Rule gate first: refuse an illegal combination before allocating anything.
    $null = Assert-YinBlockRules -BlockType $BlockType `
        -WantsInstanceDb:$WantsInstanceDb -ParentFb $ParentFb -MultiInstance:$MultiInstance

    if (-not $Inventory) { $Inventory = Get-YinBlockInventory }

    # Block names in TIA are case-insensitive and must be unique across ALL types
    $taken = @{}
    foreach ($n in $Inventory.Names) { $taken[$n.ToLowerInvariant()] = $true }

    $name = $DesiredName
    if ($taken.ContainsKey($name.ToLowerInvariant())) {
        $i = 2
        while ($taken.ContainsKey("$($DesiredName)_$i".ToLowerInvariant())) { $i++ }
        $name = "$($DesiredName)_$i"
    }

    # Number space is per family. OB numbers below 100 are reserved by the system.
    $used = switch ($BlockType) {
        'FC'         { $Inventory.FcNumbers }
        'FB'         { $Inventory.FbNumbers }
        'GlobalDB'   { $Inventory.DbNumbers }
        'InstanceDB' { $Inventory.DbNumbers }
        'OB'         { @($Inventory.Blocks | Where-Object { $_.Type -eq 'OB' } | ForEach-Object { $_.Number }) }
    }
    $usedSet = @{}
    foreach ($u in $used) { if ($null -ne $u) { $usedSet[[int]$u] = $true } }

    $start = if ($MinNumber -gt 0) { $MinNumber } elseif ($BlockType -eq 'OB') { 123 } else { 1 }
    $number = $start
    while ($usedSet.ContainsKey($number)) { $number++ }

    # An FB that needs its own instance DB: allocate that too, in one pass,
    # so the DB name/number can never collide with what we just took.
    $instanceDb = $null
    if ($BlockType -eq 'FB' -and $WantsInstanceDb) {
        $dbTaken = @{}
        foreach ($n in $Inventory.Names) { $dbTaken[$n.ToLowerInvariant()] = $true }
        $dbTaken[$name.ToLowerInvariant()] = $true   # the FB name we just claimed

        $dbBase = "$($name)_DB"
        $dbName = $dbBase
        if ($dbTaken.ContainsKey($dbName.ToLowerInvariant())) {
            $j = 2
            while ($dbTaken.ContainsKey("$($dbBase)_$j".ToLowerInvariant())) { $j++ }
            $dbName = "$($dbBase)_$j"
        }

        $dbUsed = @{}
        foreach ($u in $Inventory.DbNumbers) { if ($null -ne $u) { $dbUsed[[int]$u] = $true } }
        $dbNumber = 1
        while ($dbUsed.ContainsKey($dbNumber)) { $dbNumber++ }

        $instanceDb = [pscustomobject]@{
            Name     = $dbName
            Number   = $dbNumber
            ParentFb = $name
        }
    }

    return [pscustomobject]@{
        Name         = $name
        Number       = $number
        Renamed      = ($name -ne $DesiredName)
        OriginalName = $DesiredName
        BlockType    = $BlockType
        # FC is stateless: this stays $null by rule, never by accident.
        InstanceDb   = $instanceDb
        MultiInstance = [bool]$MultiInstance
    }
}

# ---- Capability 4a: report block-creation API surface (diagnostic) ----
# Lists exactly which Create/Import methods the running V21 provides, so we
# know whether to create blocks natively or go through XML import.
function Get-YinCreateCapabilities {
    [CmdletBinding()]
    param()

    $compType = Get-YinType 'Siemens.Engineering.SW.Blocks.PlcBlockComposition'
    $methods = @($compType.GetMethods() |
        Where-Object { $_.Name -match 'Create|Import' -and $_.Name -notmatch 'CreateFrom' } |
        ForEach-Object {
            [pscustomobject]@{
                Name   = $_.Name
                Params = (($_.GetParameters() | ForEach-Object { "$($_.ParameterType.Name) $($_.Name)" }) -join ', ')
            }
        })
    $plType = Get-YinType 'Siemens.Engineering.SW.Blocks.ProgrammingLanguage'
    return [pscustomobject]@{
        Methods = $methods
        Languages = if ($plType) { @([Enum]::GetNames($plType)) } else { @() }
    }
}

# ---- Capability 4b: export a real block to XML (reference format) ----
# Exporting an existing block reveals the exact SimaticML a running V21
# expects, so XML import can reproduce it byte-for-byte instead of guessing.
function Export-YinBlockXml {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BlockName,
        [string]$BlockPath = '',
        [string]$OutDir = (Join-Path $env:TEMP 'yin_export')
    )

    $plc = Get-YinPlcSoftware
    $resolved = Resolve-YinBlockForExport -Group $plc.BlockGroup -BlockName $BlockName -BlockPath $BlockPath
    $block = $resolved.Block

    $outDirFull = [IO.Path]::GetFullPath($OutDir)
    if (-not (Test-Path $outDirFull)) { New-Item -ItemType Directory -Path $outDirFull -Force | Out-Null }
    if (-not (Test-Path $outDirFull -PathType Container)) { throw "Export directory is invalid: $outDirFull" }

    $safeName = [IO.Path]::GetFileName($block.Name)
    if (-not $safeName -or $safeName -ne $block.Name -or $safeName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
        throw "Block name cannot be used as an export filename: $($block.Name)"
    }
    $out = Join-Path $outDirFull "$safeName.xml"

    # ExportOptions is a generic enum binding; resolve via reflection to avoid
    # the same parse-time [T] problem the GetService calls had.
    $eoType = Get-YinType 'Siemens.Engineering.ExportOptions'
    $withDefaults = [Enum]::Parse($eoType, 'WithDefaults')
    $block.Export($out, $withDefaults)

    $file = Get-Item -LiteralPath $out -ErrorAction Stop
    if ($file.Length -le 0) { throw "Export produced an empty file: $out" }
    return [pscustomobject]@{ Path = $file.FullName; Block = $block.Name; BlockPath = $resolved.Path; Length = $file.Length }
}

# ---- Capability 4: import a block from SimaticML XML (validate first) ----
# The XML must pass the official XSD before it is allowed near the project.
function Import-YinBlock {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$XmlPath,
        [switch]$SkipValidation,
        [switch]$Overwrite
    )

    if (-not (Test-Path $XmlPath)) { throw "XML file not found: $XmlPath" }

    # Gate: validate every network against the schema for ITS language.
    # LAD/FBD -> FlgNet, SCL -> StructuredText, STL -> StatementList.
    # Validating only FlgNet would silently wave SCL/STL blocks through.
    if (-not $SkipValidation) {
        Import-Module (Join-Path $PSScriptRoot 'EngineerYin.psm1') -Force
        $raw = Get-Content -LiteralPath $XmlPath -Raw

        $langMap = @(
            @{ Root = 'FlgNet';         Schema = 'SW.PlcBlocks.LADFBD_v5.xsd' }
            @{ Root = 'StructuredText'; Schema = 'SW.PlcBlocks.SCL_v4.xsd' }
            @{ Root = 'StatementList';  Schema = 'SW.PlcBlocks.STL_v5.xsd' }
        )

        $checked = 0
        $tmpDir = Join-Path $env:TEMP ("yin_imp_" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
        try {
            foreach ($lang in $langMap) {
                $nets = [regex]::Matches($raw, "<$($lang.Root)[\s\S]*?</$($lang.Root)>")
                for ($i = 0; $i -lt $nets.Count; $i++) {
                    # These schemas have no targetNamespace - strip xmlns before validating
                    $frag = $nets[$i].Value -replace '\sxmlns(:[A-Za-z_][\w.-]*)?="[^"]*"', ''
                    $fragFile = Join-Path $tmpDir "$($lang.Root)_$i.xml"
                    [System.IO.File]::WriteAllText($fragFile, $frag, [System.Text.Encoding]::UTF8)
                    $vr = Test-YinFlgNet -XmlPath $fragFile -SchemaFile $lang.Schema
                    $checked++
                    if (-not $vr.Valid) {
                        $msg = ($vr.Errors | ForEach-Object { "L$($_.Line):$($_.Pos) $($_.Message)" }) -join '; '
                        throw "XSD validation FAILED on $($lang.Root) network $($i + 1): $msg -- import aborted, project untouched."
                    }
                }
            }
        } finally {
            Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
        }

        # No recognised network at all = almost certainly a malformed file.
        # Refuse rather than hand unvalidated XML to the project.
        if ($checked -eq 0) {
            throw "No FlgNet/StructuredText/StatementList network found in '$XmlPath'. Refusing to import unvalidated XML (use -SkipValidation to override)."
        }
    }

    $plc = Get-YinPlcSoftware
    $ioType = Get-YinType 'Siemens.Engineering.ImportOptions'
    $opt = if ($Overwrite) { [Enum]::Parse($ioType, 'Override') } else { [Enum]::Parse($ioType, 'None') }

    $fi = New-Object System.IO.FileInfo($XmlPath)
    $imported = $plc.BlockGroup.Blocks.Import($fi, $opt)

    $names = @($imported | ForEach-Object { $_.Name })
    return [pscustomobject]@{
        Imported = $names
        Count    = $names.Count
        Xml      = $XmlPath
    }
}

# ---- internal: block names declared inside an SCL / AWL source file ----
# Matches FUNCTION_BLOCK "Name" / FUNCTION "Name" : Type / DATA_BLOCK "Name" /
# ORGANIZATION_BLOCK "Name", with or without the quotes.
function Get-YinSourceBlockNames {
    param([Parameter(Mandatory)][string]$SourcePath)

    $text = [System.IO.File]::ReadAllText($SourcePath, [System.Text.Encoding]::UTF8)
    $names = New-Object System.Collections.ArrayList
    $pattern = '(?im)^\s*(?:FUNCTION_BLOCK|FUNCTION|DATA_BLOCK|ORGANIZATION_BLOCK)\s+"?([A-Za-z_][\w]*)"?'
    foreach ($m in [regex]::Matches($text, $pattern)) {
        $n = $m.Groups[1].Value
        if ($n -and -not $names.Contains($n)) { [void]$names.Add($n) }
    }
    return $names
}

# ---- Capability 7: import SCL / STL from source text ----
# SCL and STL block XML is a token-level format (StructuredText / StatementList
# with an enumerated STL token set), which a language model cannot author
# reliably. Openness offers a supported alternative: drop the plain source text
# into ExternalSources and let TIA itself compile it into real blocks.
# Accepts .scl (SCL) or .awl (STL) files.
function Import-YinSourceFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$SourcePath,
        [switch]$Overwrite
    )

    if (-not (Test-Path $SourcePath)) { throw "Source file not found: $SourcePath" }

    $plc = Get-YinPlcSoftware
    $sources = $plc.ExternalSourceGroup.ExternalSources
    $sourceName = [IO.Path]::GetFileName($SourcePath)

    # A stale source object of the same name blocks CreateFromFile
    $existingSource = $sources.Find($sourceName)
    if ($existingSource) { $existingSource.Delete() }

    # GenerateBlockOption only offers None / KeepOnError - there is no overwrite
    # flag, so a same-named block must be removed first or generation fails.
    $declared = Get-YinSourceBlockNames -SourcePath $SourcePath
    if ($Overwrite) {
        foreach ($name in $declared) {
            $null = Remove-YinBlockByName -BlockName $name
        }
    }

    # Snapshot AFTER the deletions: taking it earlier would classify a
    # deleted-then-regenerated block as "not new" and report Count=0.
    $before = @(Get-YinBlocksRecursive -Group $plc.BlockGroup | ForEach-Object { $_.Name })

    $src = $sources.CreateFromFile($sourceName, $SourcePath)

    $optType = Get-YinType 'Siemens.Engineering.SW.ExternalSources.GenerateBlockOption'
    $opt = [Enum]::Parse($optType, 'KeepOnError')

    # GenerateBlocksFromSource is overloaded; bind the single-argument form.
    $method = $src.GetType().GetMethods() |
        Where-Object { $_.Name -eq 'GenerateBlocksFromSource' -and $_.GetParameters().Count -eq 1 } |
        Select-Object -First 1
    if (-not $method) { throw "GenerateBlocksFromSource(GenerateBlockOption) not available." }

    try {
        $null = $method.Invoke($src, @($opt))
    } catch {
        # Unwrap the reflection wrapper so the caller sees the real TIA message
        $inner = $_.Exception
        while ($inner.InnerException) { $inner = $inner.InnerException }
        try { $src.Delete() } catch { }
        throw $inner.Message
    }

    $after = @(Get-YinBlocksRecursive -Group $plc.BlockGroup | ForEach-Object { $_.Name })
    $created = @($after | Where-Object { $before -notcontains $_ })

    # The source object has served its purpose; leaving it clutters the project
    try { $src.Delete() } catch { }

    # KeepOnError lets generation "succeed" while producing nothing usable.
    # Verify every block the source declares actually exists now, otherwise the
    # caller would see ok=true for an import that silently did nothing.
    $missing = @($declared | Where-Object { $after -notcontains $_ })
    if ($missing.Count -gt 0) {
        throw ("Source generated no block for: " + ($missing -join ', ') + ". Check the source syntax (TIA reported no usable block).")
    }

    return [pscustomobject]@{
        Imported = $created
        Declared = $declared
        Count    = $created.Count
        Source   = $SourcePath
    }
}

# ---- Capability 8: delete a block by name ----
# Needed for cleanup and for source overwrite: GenerateBlockOption has no
# overwrite flag, so a same-named block must be removed before regeneration.
# Returns the paths actually removed (empty when the name was not present).
function Remove-YinBlockByName {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BlockName,
        [string]$BlockPath = ''
    )

    $plc = Get-YinPlcSoftware
    $matches = @(Find-YinBlockMatchesRecursive -Group $plc.BlockGroup -BlockName $BlockName)
    if ($BlockPath) {
        $matches = @($matches | Where-Object { $_.Path -eq $BlockPath })
    }

    $removed = New-Object System.Collections.ArrayList
    foreach ($m in $matches) {
        try {
            $m.Block.Delete()
            [void]$removed.Add($m.Path)
        } catch {
            # A block in use by others cannot be deleted - report rather than hide
            throw "Cannot delete '$($m.Path)': $($_.Exception.Message)"
        }
    }
    return $removed
}

# ---- Capability 5: PLC tag table (English symbols, Chinese comments) ----
function New-YinTagTable {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TableName,
        # Each tag: @{ Name='Start_PB'; DataType='Bool'; Address='%I0.0'; Comment='qi dong an niu' }
        [Parameter(Mandatory)][array]$Tags
    )

    $plc = Get-YinPlcSoftware

    $table = $plc.TagTableGroup.TagTables | Where-Object { $_.Name -eq $TableName } | Select-Object -First 1
    if (-not $table) { $table = $plc.TagTableGroup.TagTables.Create($TableName) }

    $added = New-Object System.Collections.ArrayList
    $skipped = New-Object System.Collections.ArrayList

    foreach ($t in $Tags) {
        $existing = $table.Tags | Where-Object { $_.Name -eq $t.Name } | Select-Object -First 1
        if ($existing) { [void]$skipped.Add($t.Name); continue }

        $tag = $table.Tags.Create($t.Name)
        if ($t.DataType) { $tag.DataTypeName = $t.DataType }
        if ($t.Address)  { $tag.LogicalAddress = $t.Address }
        if ($t.Comment) {
            # Comment is multilingual - set the zh-CN item so Chinese shows in TIA
            try { $tag.Comment.Items[0].Text = $t.Comment } catch { }
        }
        [void]$added.Add($t.Name)
    }

    return [pscustomobject]@{
        TableName = $TableName
        Added     = $added
        Skipped   = $skipped
    }
}

# ---- Capability 6: compile and return structured diagnostics ----
function Invoke-YinCompile {
    [CmdletBinding()]
    param([switch]$SaveAfter)

    $plc = Get-YinPlcSoftware
    $compilableType = Get-YinType 'Siemens.Engineering.Compiler.ICompilable'
    $compiler = Invoke-YinGetService -Target $plc -ServiceType $compilableType
    if (-not $compiler) { throw "Compiler service unavailable on $($plc.Name)." }
    $result = $compiler.Compile()

    $messages = New-Object System.Collections.ArrayList
    # The compiler returns a tree: PLC_1 / Program blocks / <BlockName (FB1)> /
    # <line-level errors>. A leaf's own Path is a LINE NUMBER; the block name is
    # on the depth-2 ancestor's Path. Carry the ancestor Path chain down so
    # callers can attribute an error to the right block - attributing by the
    # leaf's own Path blames a line number and matches nothing.
    function Walk-Msg($msg, $depth, $ancestry) {
        [void]$messages.Add([pscustomobject]@{
            State       = "$($msg.State)"
            Description = $msg.Description
            Path        = $msg.Path
            Depth       = $depth
            Ancestry    = $ancestry
        })
        $own = "$($msg.Path)"
        $childAncestry = if ($ancestry) { $ancestry + '/' + $own } else { $own }
        foreach ($m in $msg.Messages) { Walk-Msg $m ($depth + 1) $childAncestry }
    }
    foreach ($m in $result.Messages) { Walk-Msg $m 0 '' }

    if ($SaveAfter -and $script:Project) { $script:Project.Save() }

    return [pscustomobject]@{
        State        = "$($result.State)"
        ErrorCount   = $result.ErrorCount
        WarningCount = $result.WarningCount
        Messages     = $messages
        Saved        = [bool]$SaveAfter
    }
}

Export-ModuleMember -Function `
    Initialize-YinAssemblies, `
    Connect-YinPortal, Disconnect-YinPortal, Test-YinPortalConnection, `
    Get-YinBlockInventory, Get-YinCreateCapabilities, `
    Assert-YinBlockRules, New-YinSafeBlockName, `
    Import-YinBlock, Import-YinSourceFile, Remove-YinBlockByName, New-YinTagTable, Invoke-YinCompile, Export-YinBlockXml
