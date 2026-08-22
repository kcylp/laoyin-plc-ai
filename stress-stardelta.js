// 复杂程序压测：星三角启动（真实工程场景）
// 4 个网络 + TON 延时 + SCoil/RCoil 置复位 + 星角硬件互锁
const { validateLadBusinessRules, importToTia, stopSharedEngineClients } = require('./engineer-yin-bridge');

const unit = (id, flg, title) => `
      <SW.Blocks.CompileUnit ID="${id}" CompositionName="CompileUnits">
        <AttributeList>
          <NetworkSource>
            <FlgNet xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/FlgNet/v4">${flg}</FlgNet>
          </NetworkSource>
          <ProgrammingLanguage>LAD</ProgrammingLanguage>
        </AttributeList>
        <ObjectList>
          <MultilingualText ID="${id}01" CompositionName="Title">
            <ObjectList>
              <MultilingualTextItem ID="${id}02" CompositionName="Items">
                <AttributeList><Culture>zh-CN</Culture><Text>${title}</Text></AttributeList>
              </MultilingualTextItem>
            </ObjectList>
          </MultilingualText>
        </ObjectList>
      </SW.Blocks.CompileUnit>`;

// 网络1：起保停自锁 —— (StartCmd OR MotorRun) AND NOT StopCmd -> MotorRun
const net1 = `
  <Parts>
    <Access UId="31" Scope="LocalVariable"><Symbol><Component Name="StartCmd" /></Symbol></Access>
    <Access UId="32" Scope="LocalVariable"><Symbol><Component Name="MotorRun" /></Symbol></Access>
    <Access UId="33" Scope="LocalVariable"><Symbol><Component Name="StopCmd" /></Symbol></Access>
    <Access UId="34" Scope="LocalVariable"><Symbol><Component Name="MotorRun" /></Symbol></Access>
    <Part Name="Contact" UId="21" />
    <Part Name="Contact" UId="22" />
    <Part Name="Contact" UId="23"><Negated Name="operand" /></Part>
    <Part Name="Coil" UId="24" />
    <Part Name="O" UId="25"><TemplateValue Name="Card" Type="Cardinality">2</TemplateValue></Part>
  </Parts>
  <Wires>
    <Wire UId="51"><Powerrail /><NameCon UId="21" Name="in" /><NameCon UId="22" Name="in" /></Wire>
    <Wire UId="52"><IdentCon UId="31" /><NameCon UId="21" Name="operand" /></Wire>
    <Wire UId="53"><IdentCon UId="32" /><NameCon UId="22" Name="operand" /></Wire>
    <Wire UId="54"><NameCon UId="21" Name="out" /><NameCon UId="25" Name="in1" /></Wire>
    <Wire UId="55"><NameCon UId="22" Name="out" /><NameCon UId="25" Name="in2" /></Wire>
    <Wire UId="56"><NameCon UId="25" Name="out" /><NameCon UId="23" Name="in" /></Wire>
    <Wire UId="57"><IdentCon UId="33" /><NameCon UId="23" Name="operand" /></Wire>
    <Wire UId="58"><NameCon UId="23" Name="out" /><NameCon UId="24" Name="in" /></Wire>
    <Wire UId="59"><IdentCon UId="34" /><NameCon UId="24" Name="operand" /></Wire>
  </Wires>`;

// 网络2：TON 延时 5 秒 —— MotorRun 驱动定时器，Q 给 TimerDone
// 故意把 OpenCon 写在 ET 前面，验证顺序无关的修复
const net2 = `
  <Parts>
    <Access UId="61" Scope="LocalVariable"><Symbol><Component Name="MotorRun" /></Symbol></Access>
    <Access UId="62" Scope="TypedConstant"><Constant><ConstantValue>T#5s</ConstantValue></Constant></Access>
    <Access UId="63" Scope="LocalVariable"><Symbol><Component Name="TimerDone" /></Symbol></Access>
    <Part Name="Contact" UId="64" />
    <Part Name="TON" Version="1.0" UId="65">
      <Instance Scope="LocalVariable" UId="66"><Component Name="StartTimer" /></Instance>
      <TemplateValue Name="time_type" Type="Type">Time</TemplateValue>
    </Part>
    <Part Name="Coil" UId="67" />
  </Parts>
  <Wires>
    <Wire UId="71"><Powerrail /><NameCon UId="64" Name="in" /></Wire>
    <Wire UId="72"><IdentCon UId="61" /><NameCon UId="64" Name="operand" /></Wire>
    <Wire UId="73"><NameCon UId="64" Name="out" /><NameCon UId="65" Name="IN" /></Wire>
    <Wire UId="74"><IdentCon UId="62" /><NameCon UId="65" Name="PT" /></Wire>
    <Wire UId="75"><NameCon UId="65" Name="Q" /><NameCon UId="67" Name="in" /></Wire>
    <Wire UId="76"><IdentCon UId="63" /><NameCon UId="67" Name="operand" /></Wire>
    <Wire UId="77"><OpenCon UId="78" /><NameCon UId="65" Name="ET" /></Wire>
  </Wires>`;

// 网络3：星接触器 —— MotorRun AND NOT TimerDone AND NOT DeltaContactor -> StarContactor
const net3 = `
  <Parts>
    <Access UId="81" Scope="LocalVariable"><Symbol><Component Name="MotorRun" /></Symbol></Access>
    <Access UId="82" Scope="LocalVariable"><Symbol><Component Name="TimerDone" /></Symbol></Access>
    <Access UId="83" Scope="LocalVariable"><Symbol><Component Name="DeltaContactor" /></Symbol></Access>
    <Access UId="84" Scope="LocalVariable"><Symbol><Component Name="StarContactor" /></Symbol></Access>
    <Part Name="Contact" UId="85" />
    <Part Name="Contact" UId="86"><Negated Name="operand" /></Part>
    <Part Name="Contact" UId="87"><Negated Name="operand" /></Part>
    <Part Name="Coil" UId="88" />
  </Parts>
  <Wires>
    <Wire UId="91"><Powerrail /><NameCon UId="85" Name="in" /></Wire>
    <Wire UId="92"><IdentCon UId="81" /><NameCon UId="85" Name="operand" /></Wire>
    <Wire UId="93"><NameCon UId="85" Name="out" /><NameCon UId="86" Name="in" /></Wire>
    <Wire UId="94"><IdentCon UId="82" /><NameCon UId="86" Name="operand" /></Wire>
    <Wire UId="95"><NameCon UId="86" Name="out" /><NameCon UId="87" Name="in" /></Wire>
    <Wire UId="96"><IdentCon UId="83" /><NameCon UId="87" Name="operand" /></Wire>
    <Wire UId="97"><NameCon UId="87" Name="out" /><NameCon UId="88" Name="in" /></Wire>
    <Wire UId="98"><IdentCon UId="84" /><NameCon UId="88" Name="operand" /></Wire>
  </Wires>`;

// 网络4：角接触器 —— MotorRun AND TimerDone AND NOT StarContactor -> DeltaContactor
const net4 = `
  <Parts>
    <Access UId="101" Scope="LocalVariable"><Symbol><Component Name="MotorRun" /></Symbol></Access>
    <Access UId="102" Scope="LocalVariable"><Symbol><Component Name="TimerDone" /></Symbol></Access>
    <Access UId="103" Scope="LocalVariable"><Symbol><Component Name="StarContactor" /></Symbol></Access>
    <Access UId="104" Scope="LocalVariable"><Symbol><Component Name="DeltaContactor" /></Symbol></Access>
    <Part Name="Contact" UId="105" />
    <Part Name="Contact" UId="106" />
    <Part Name="Contact" UId="107"><Negated Name="operand" /></Part>
    <Part Name="Coil" UId="108" />
  </Parts>
  <Wires>
    <Wire UId="111"><Powerrail /><NameCon UId="105" Name="in" /></Wire>
    <Wire UId="112"><IdentCon UId="101" /><NameCon UId="105" Name="operand" /></Wire>
    <Wire UId="113"><NameCon UId="105" Name="out" /><NameCon UId="106" Name="in" /></Wire>
    <Wire UId="114"><IdentCon UId="102" /><NameCon UId="106" Name="operand" /></Wire>
    <Wire UId="115"><NameCon UId="106" Name="out" /><NameCon UId="107" Name="in" /></Wire>
    <Wire UId="116"><IdentCon UId="103" /><NameCon UId="107" Name="operand" /></Wire>
    <Wire UId="117"><NameCon UId="107" Name="out" /><NameCon UId="108" Name="in" /></Wire>
    <Wire UId="118"><IdentCon UId="104" /><NameCon UId="108" Name="operand" /></Wire>
  </Wires>`;

const xml = `<?xml version="1.0" encoding="utf-8"?>
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
            <Member Name="StartCmd" Datatype="Bool" Accessibility="Public" />
            <Member Name="StopCmd" Datatype="Bool" Accessibility="Public" />
          </Section>
          <Section Name="Output">
            <Member Name="StarContactor" Datatype="Bool" Accessibility="Public" />
            <Member Name="DeltaContactor" Datatype="Bool" Accessibility="Public" />
          </Section>
          <Section Name="InOut" />
          <Section Name="Static">
            <Member Name="MotorRun" Datatype="Bool" Accessibility="Public" />
            <Member Name="TimerDone" Datatype="Bool" Accessibility="Public" />
            <Member Name="StartTimer" Datatype="TON_TIME" Accessibility="Public" />
          </Section>
          <Section Name="Temp" />
          <Section Name="Constant" />
        </Sections>
      </Interface>
      <IsIECCheckEnabled>true</IsIECCheckEnabled>
      <MemoryLayout>Optimized</MemoryLayout>
      <Name>Stress_StarDelta</Name>
      <Namespace />
      <Number>50</Number>
      <ProgrammingLanguage>LAD</ProgrammingLanguage>
      <SetENOAutomatically>false</SetENOAutomatically>
      <UDABlockProperties /><UDAEnableTagReadback>false</UDAEnableTagReadback>
    </AttributeList>
    <ObjectList>
${unit(3, net1, 'N1 起保停自锁')}
${unit(4, net2, 'N2 星角切换延时5秒')}
${unit(5, net3, 'N3 星接触器(角未吸合时)')}
${unit(6, net4, 'N4 角接触器(星断开后)')}
    </ObjectList>
  </SW.Blocks.FB>
</Document>`;

(async () => {
    console.log('=== 星三角 FB：4网络 + TON + 硬件互锁 ===');
    const v = validateLadBusinessRules(xml);
    console.log('业务规则校验 valid=' + v.valid);
    v.errors.forEach(e => console.log('  [' + e.rule + '] net' + e.network + ' ' + e.message + (e.uid ? ' uid=' + e.uid : '')));
    if (!v.valid) { console.log('校验未过，终止'); return; }

    const r = await importToTia(xml, true);
    console.log('\n写入结果:');
    console.log('  ok=' + r.ok + ' imported=' + JSON.stringify(r.imported));
    console.log('  本块 errors=' + r.errorCount + ' warnings=' + r.warningCount + ' | 项目其他块 errors=' + r.otherBlockErrors);
    if (r.autoFixes) console.log('  autoFixes=' + JSON.stringify(r.autoFixes));
    if (!r.ok) {
        (r.messages || []).filter(m => /^Error/i.test(m)).slice(0, 6).forEach(m => console.log('   ' + m));
        if (r.message) console.log('   message: ' + String(r.message).slice(0, 300));
    }
})().finally(() => {
    stopSharedEngineClients();
});
