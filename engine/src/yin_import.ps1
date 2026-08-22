param(
    [Parameter(Mandatory)][string]$EngineRoot,
    [Parameter(Mandatory)][ValidateSet('preflight', 'import')][string]$Mode,
    [Parameter(Mandatory)][string]$XmlPath,
    [switch]$Overwrite,
    # Source mode: XmlPath points at plain SCL/AWL text instead of block XML.
    # SCL/STL block XML is a token-level format no model can author reliably,
    # so those two languages go through Openness ExternalSources instead.
    [ValidateSet('xml', 'scl', 'stl')][string]$Kind = 'xml'
)
# Pure ASCII on purpose: PS 5.1 on a Chinese locale reads a UTF-8-no-BOM .ps1
# as GBK, which corrupts localized literals and paths. All paths arrive as
# parameters from the command line, where UTF-8 survives.
#
# Modes:
#   preflight - connect, read inventory, report what WOULD happen. No writes.
#   import    - validate (mandatory), import, compile, report. Writes.
#
# Always emits a single line of JSON on stdout.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot 'YinImportCore.ps1')

$connected = $false
try {
    $conn = Connect-YinImportSession -EngineRoot $EngineRoot
    $connected = $true
    $result = Invoke-YinImportRequest -EngineRoot $EngineRoot -Mode $Mode -XmlPath $XmlPath -Overwrite:$Overwrite -Kind $Kind -Connection $conn
    Write-YinJsonLine $result
    Disconnect-YinPortal
    exit 0
}
catch {
    Write-YinJsonLine ([pscustomobject]@{
        ok      = $false
        stage   = 'error'
        message = $_.Exception.Message
    })
    if ($connected) { try { Disconnect-YinPortal } catch { } }
    exit 1
}
