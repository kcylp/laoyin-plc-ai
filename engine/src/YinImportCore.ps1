# Shared import/preflight implementation for yin_import.ps1 and yin_worker.ps1.
# Keep this file ASCII-only. All localized payloads arrive through files/params.

$script:YinImportCoreLoaded = $false
$script:YinImportAssembliesReady = $false

function Write-YinJsonLine($obj) {
    Write-Output ($obj | ConvertTo-Json -Depth 6 -Compress)
}

function Initialize-YinImportCore {
    param([Parameter(Mandatory)][string]$EngineRoot)
    if (-not $script:YinImportCoreLoaded) {
        Import-Module (Join-Path $EngineRoot 'src\EngineerYin.Write.psm1') -Force
        $script:YinImportCoreLoaded = $true
    }
    if (-not $script:YinImportAssembliesReady) {
        $null = Initialize-YinAssemblies
        $script:YinImportAssembliesReady = $true
    }
}

function Connect-YinImportSession {
    param([Parameter(Mandatory)][string]$EngineRoot)
    Initialize-YinImportCore -EngineRoot $EngineRoot
    return Connect-YinPortal
}

function Invoke-YinImportRequest {
    param(
        [Parameter(Mandatory)][string]$EngineRoot,
        [Parameter(Mandatory)][ValidateSet('preflight', 'import')][string]$Mode,
        [Parameter(Mandatory)][string]$XmlPath,
        [switch]$Overwrite,
        [ValidateSet('xml', 'scl', 'stl')][string]$Kind = 'xml',
        [Parameter(Mandatory)]$Connection
    )

    Initialize-YinImportCore -EngineRoot $EngineRoot
    $inv = Get-YinBlockInventory
    $raw = [System.IO.File]::ReadAllText($XmlPath, [System.Text.Encoding]::UTF8)

    if ($Kind -eq 'xml') {
        # Pull the target block's identity straight out of the XML text.
        # Regex rather than [xml] cast: the file carries several namespaces and we
        # only need four scalar fields.
        $mName = [regex]::Match($raw, '<Name>([^<]+)</Name>')
        $mNum = [regex]::Match($raw, '<Number>(\d+)</Number>')
        $mType = [regex]::Match($raw, '<SW\.Blocks\.(FC|FB|GlobalDB|InstanceDB|OB)\b')
        $mLang = [regex]::Match($raw, '<ProgrammingLanguage>([^<]+)</ProgrammingLanguage>')

        $blockName = if ($mName.Success) { $mName.Groups[1].Value } else { '' }
        $blockNum = if ($mNum.Success) { [int]$mNum.Groups[1].Value } else { 0 }
        $blockType = if ($mType.Success) { $mType.Groups[1].Value } else { 'unknown' }
        $blockLang = if ($mLang.Success) { $mLang.Groups[1].Value } else { '' }
    }
    else {
        # Source mode: block identity comes from the source declaration header.
        $mDecl = [regex]::Match($raw, '(?im)^\s*(FUNCTION_BLOCK|FUNCTION|DATA_BLOCK|ORGANIZATION_BLOCK)\s+"?([A-Za-z_][\w]*)"?')
        $blockName = if ($mDecl.Success) { $mDecl.Groups[2].Value } else { '' }
        $blockNum = 0
        $blockType = if ($mDecl.Success) {
            switch ($mDecl.Groups[1].Value.ToUpper()) {
                'FUNCTION_BLOCK'     { 'FB' }
                'FUNCTION'           { 'FC' }
                'DATA_BLOCK'         { 'GlobalDB' }
                'ORGANIZATION_BLOCK' { 'OB' }
                default              { 'unknown' }
            }
        } else { 'unknown' }
        $blockLang = $Kind.ToUpper()

        if (-not $blockName) {
            return [pscustomobject]@{
                ok      = $false
                stage   = 'precheck'
                message = 'No FUNCTION_BLOCK / FUNCTION / DATA_BLOCK / ORGANIZATION_BLOCK declaration found in the source.'
            }
        }
    }

    $nameTaken = $false
    foreach ($n in $inv.Names) {
        if ($n -eq $blockName) { $nameTaken = $true }
    }

    # Probe installed TIA version from registry - never hardcode V21.
    $tiaVersion = ''
    try {
        $tiaVersion = (Get-YinTiaInstall).EngineeringVersion
    } catch {
        # Probe failed: leave empty; UI shows unknown.
    }

    if ($Mode -eq 'preflight') {
        return [pscustomobject]@{
            ok             = $true
            project        = $Connection.ProjectName
            plc            = $inv.PlcName
            tiaVersion     = $tiaVersion
            existingCount  = $inv.Count
            existingNames  = @($inv.Names)
            blockName      = $blockName
            blockNumber    = $blockNum
            blockType      = $blockType
            language       = $blockLang
            nameTaken      = $nameTaken
            kind           = $Kind
        }
    }

    # Import mode. Refuse a silent overwrite: the caller must opt in explicitly.
    if ($nameTaken -and -not $Overwrite) {
        return [pscustomobject]@{
            ok      = $false
            stage   = 'precheck'
            message = "Block '$blockName' already exists in $($inv.PlcName). Rename the block or allow overwrite."
        }
    }

    if ($Kind -eq 'xml') {
        # No -SkipValidation here on purpose: XML arriving from the web is
        # untrusted, so the XSD gate is mandatory on this path.
        $imp = Import-YinBlock -XmlPath $XmlPath -Overwrite:$Overwrite
    }
    else {
        # ExternalSources needs the real extension to pick its parser.
        $ext = if ($Kind -eq 'scl') { '.scl' } else { '.awl' }
        $srcPath = [System.IO.Path]::Combine(
            [System.IO.Path]::GetDirectoryName($XmlPath),
            ($blockName + $ext))
        # BOM is mandatory: without it TIA misreads UTF-8 as the system ANSI
        # codepage (GBK on a Chinese Windows), and a Chinese comment whose
        # byte count is odd swallows the newline, eating the NEXT variable
        # declaration - the generated block then loses interface members and
        # compile fails with "Tag #x not defined". Proven by probe 2026-08-05.
        [System.IO.File]::WriteAllText($srcPath, $raw, (New-Object System.Text.UTF8Encoding($true)))
        try {
            $imp = Import-YinSourceFile -SourcePath $srcPath -Overwrite:$Overwrite
        } finally {
            Remove-Item $srcPath -Force -ErrorAction SilentlyContinue
        }
    }

    $cmp = Invoke-YinCompile

    # Invoke-YinCompile compiles the whole PLC, so pre-existing broken blocks
    # would otherwise be reported as if this write had caused them.
    # A message's own Path is a line number; the block name appears on an
    # ancestor node, which Invoke-YinCompile exposes as Ancestry.
    $targets = @($imp.Imported)
    if (-not $targets.Count) { $targets = @($blockName) }

    $isMine = {
        param($msg)
        # Leaf errors carry the block name in Ancestry; the block's own node
        # carries it in Path. Check both so either shape attributes correctly.
        $hay = "$($msg.Ancestry)/$($msg.Path)"
        foreach ($t in $targets) {
            if ($hay -like "*$t*") { return $true }
        }
        return $false
    }

    $withDesc = @($cmp.Messages | Where-Object { $_.Description })
    # Root rollup lines carry no ancestry and no path - they repeat the leaf
    # errors, so counting them double-counts and their empty ancestry would
    # poison attribution below.
    $leafish = @($withDesc | Where-Object { "$($_.Ancestry)" -ne '' -or "$($_.Path)" -ne '' })
    $allErrors = @($leafish | Where-Object { "$($_.State)" -eq 'Error' })
    $mine = @($leafish | Where-Object { & $isMine $_ })
    $myErrors = @($mine | Where-Object { "$($_.State)" -eq 'Error' })
    $myWarnings = @($mine | Where-Object { "$($_.State)" -eq 'Warning' })
    $otherErrors = @($allErrors | Where-Object { -not (& $isMine $_) })

    # A clean block produces no message node at all. Attribution can only be
    # distrusted when an error has no ancestry at all - then it might be ours.
    $unattributed = @($allErrors | Where-Object { "$($_.Ancestry)" -eq '' })
    $attributionWorked = ($unattributed.Count -eq 0)
    if (-not $attributionWorked) {
        # Cannot prove this block is clean - report the project total instead of
        # silently passing. Over-reporting beats hiding a failed write.
        $myErrors = $allErrors
        $otherErrors = @()
    }

    # Show this block's own messages first; project-wide ones only as context.
    $ordered = @($mine) + @($withDesc | Where-Object { -not (& $isMine $_) })

    return [pscustomobject]@{
        ok                = ($myErrors.Count -eq 0)
        stage             = 'done'
        project           = $Connection.ProjectName
        imported          = @($imp.Imported)
        blockName         = $blockName
        blockType         = $blockType
        kind              = $Kind
        compileState      = "$($cmp.State)"
        errorCount        = $myErrors.Count
        warningCount      = $myWarnings.Count
        projectErrorCount = $cmp.ErrorCount
        otherBlockErrors  = $otherErrors.Count
        attributed        = $attributionWorked
        messages          = @($ordered |
            Select-Object -First 30 |
            ForEach-Object { "$($_.State): $($_.Description)" })
    }
}
