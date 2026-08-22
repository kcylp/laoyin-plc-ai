# Probe: drive a generic IEC_COUNTER (InOut parameter) from a LAD network.
# The SCL source channel rejects ANY call on IEC_COUNTER (all formal params
# invalid) while read access (.CV/.QU) works. FlgNet Instance Scope has no
# InOut-specific value (Scope_TE enum) - InOut members are LocalVariable too,
# so a CTU part can point its Instance at the InOut member.
# XML block import route (proven channel), then compile.
# Pure ASCII (PS 5.1 GBK trap).
param([Parameter(Mandatory)][string]$EngineRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Import-Module (Join-Path $EngineRoot 'src\EngineerYin.Write.psm1') -Force
$null = Initialize-YinAssemblies
$conn = Connect-YinPortal
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$xml = @'
<?xml version="1.0" encoding="utf-8"?>
<Document>
  <Engineering version="V21" />
  <DocumentInfo><ExportSetting>WithDefaults</ExportSetting></DocumentInfo>
  <SW.Blocks.FB ID="0">
    <AttributeList>
      <AutoNumber>true</AutoNumber>
      <HeaderAuthor /><HeaderFamily /><HeaderName /><HeaderVersion>0.1</HeaderVersion>
      <Interface>
        <Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5">
          <Section Name="Input">
            <Member Name="Pulse" Datatype="Bool" Accessibility="Public" />
            <Member Name="Reset" Datatype="Bool" Accessibility="Public" />
            <Member Name="Preset" Datatype="Int" Accessibility="Public" />
          </Section>
          <Section Name="Output">
            <Member Name="Done" Datatype="Bool" Accessibility="Public" />
          </Section>
          <Section Name="InOut">
            <Member Name="Cnt" Datatype="IEC_COUNTER" Accessibility="Public" />
          </Section>
          <Section Name="Static" />
          <Section Name="Temp" />
          <Section Name="Constant" />
        </Sections>
      </Interface>
      <IsIECCheckEnabled>true</IsIECCheckEnabled>
      <MemoryLayout>Optimized</MemoryLayout>
      <Name>ProbeGenCtuLad</Name>
      <Namespace />
      <Number>60</Number>
      <ProgrammingLanguage>LAD</ProgrammingLanguage>
      <SetENOAutomatically>false</SetENOAutomatically>
      <UDABlockProperties /><UDAEnableTagReadback>false</UDAEnableTagReadback>
    </AttributeList>
    <ObjectList>
      <SW.Blocks.CompileUnit ID="3" CompositionName="CompileUnits">
        <AttributeList>
          <NetworkSource>
            <FlgNet xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/FlgNet/v4">
              <Parts>
                <Access UId="31" Scope="LocalVariable"><Symbol><Component Name="Pulse" /></Symbol></Access>
                <Access UId="32" Scope="LocalVariable"><Symbol><Component Name="Reset" /></Symbol></Access>
                <Access UId="33" Scope="TypedConstant"><Constant><ConstantValue>Int#5</ConstantValue></Constant></Access>
                <Access UId="34" Scope="LocalVariable"><Symbol><Component Name="Done" /></Symbol></Access>
                <Part Name="Contact" UId="21" />
                <Part Name="CTU" UId="22">
                  <Instance Scope="LocalVariable" UId="23"><Component Name="Cnt" /></Instance>
                  <TemplateValue Name="value_type" Type="Type">Int</TemplateValue>
                </Part>
                <Part Name="Coil" UId="24" />
              </Parts>
              <Wires>
                <Wire UId="51"><Powerrail /><NameCon UId="21" Name="in" /></Wire>
                <Wire UId="52"><IdentCon UId="31" /><NameCon UId="21" Name="operand" /></Wire>
                <Wire UId="53"><NameCon UId="21" Name="out" /><NameCon UId="22" Name="CU" /></Wire>
                <Wire UId="54"><IdentCon UId="32" /><NameCon UId="22" Name="R" /></Wire>
                <Wire UId="55"><IdentCon UId="33" /><NameCon UId="22" Name="PV" /></Wire>
                <Wire UId="56"><NameCon UId="22" Name="Q" /><NameCon UId="24" Name="in" /></Wire>
                <Wire UId="57"><IdentCon UId="34" /><NameCon UId="24" Name="operand" /></Wire>
                <Wire UId="58"><OpenCon UId="59" /><NameCon UId="22" Name="CV" /></Wire>
              </Wires>
            </FlgNet>
          </NetworkSource>
          <ProgrammingLanguage>LAD</ProgrammingLanguage>
        </AttributeList>
      </SW.Blocks.CompileUnit>
    </ObjectList>
  </SW.Blocks.FB>
</Document>
'@

$xmlPath = Join-Path $env:TEMP 'ProbeGenCtuLad.xml'
[System.IO.File]::WriteAllText($xmlPath, $xml, $utf8NoBom)
try {
    $null = Import-YinBlock -XmlPath $xmlPath -Overwrite
    Write-Output 'IMPORT ok'
    $cmp = Invoke-YinCompile
    $mine = @($cmp.Messages | Where-Object {
        "$($_.Ancestry)/$($_.Path)" -like '*ProbeGenCtuLad*' -and $_.Description
    })
    $errs = @($mine | Where-Object { "$($_.State)" -eq 'Error' })
    Write-Output ("BLOCK ProbeGenCtuLad errors=" + $errs.Count)
    $mine | Select-Object -First 8 | ForEach-Object { Write-Output ("    [" + $_.State + "] " + $_.Description) }
} catch {
    Write-Output ('IMPORT failed: ' + $_.Exception.Message)
} finally {
    Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue
    try { $null = Remove-YinBlockByName -BlockName 'ProbeGenCtuLad' } catch { }
}
Disconnect-YinPortal
