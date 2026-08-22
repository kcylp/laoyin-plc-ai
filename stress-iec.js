// IEC 指令压测：计数器 + 模拟量输入/输出标定（真实工程场景）
const { importToTia, stopSharedEngineClients } = require('./engineer-yin-bridge');

// 计数器：CTU 上升沿计数 + 到达设定值锁存 + 复位（IEC_COUNTER 静态实例）
const sclCounter = `FUNCTION_BLOCK "Stress_Counter"
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1

VAR_INPUT
   Pulse : Bool;                 // 计数脉冲
   Reset : Bool;                 // 复位
   Preset : Int;                 // 设定值
END_VAR

VAR_OUTPUT
   Done : Bool;                  // 到达设定值
   CurrentValue : Int;           // 当前计数值
END_VAR

VAR
   Cnt : CTU_INT;                // CTU 计数器实例（必须用具体类型，不能用 IEC_COUNTER）
END_VAR

BEGIN
    // 实测规则：计数器的 Q 必须在调用时用 => 绑定，事后 #Cnt.Q 报"未定义"；CV 可事后读
    #Cnt(CU := #Pulse, R := #Reset, PV := #Preset, Q => #Done);
    #CurrentValue := #Cnt.CV;
END_FUNCTION_BLOCK
`;

// 模拟量输入：4-20mA / 0-27648 原始值 → NORM_X 归一 → SCALE_X 工程量
const sclAnalogIn = `FUNCTION_BLOCK "Stress_AnalogIn"
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1

VAR_INPUT
   RawValue : Int;               // 模块原始值 0..27648（现场接 %IW）
   EngMin : Real;                // 工程量下限
   EngMax : Real;                // 工程量上限
END_VAR

VAR_OUTPUT
   EngValue : Real;              // 标定后工程量
   Overflow : Bool;              // 超上限
   Underflow : Bool;             // 低于下限（断线）
END_VAR

VAR_TEMP
   Norm : Real;
END_VAR

BEGIN
    #Norm := NORM_X(MIN := 0, VALUE := #RawValue, MAX := 27648);
    #EngValue := SCALE_X(MIN := #EngMin, VALUE := #Norm, MAX := #EngMax);
    #Overflow := #RawValue > 27648;
    #Underflow := #RawValue < 0;
END_FUNCTION_BLOCK
`;

// 模拟量输出：工程量 → 0..27648 原始值（输出给 %QW），含上下限钳位
const sclAnalogOut = `FUNCTION_BLOCK "Stress_AnalogOut"
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1

VAR_INPUT
   EngValue : Real;              // 工程量输入
   EngMin : Real;
   EngMax : Real;
END_VAR

VAR_OUTPUT
   RawValue : Int;               // 模块原始值（现场写 %QW）
END_VAR

VAR_TEMP
   Norm : Real;
   Clamped : Real;
END_VAR

BEGIN
    // 钳位到工程量程内，防止 SCALE 溢出
    IF #EngValue > #EngMax THEN
        #Clamped := #EngMax;
    ELSIF #EngValue < #EngMin THEN
        #Clamped := #EngMin;
    ELSE
        #Clamped := #EngValue;
    END_IF;
    #Norm := SCALE_X(MIN := #EngMin, VALUE := #Clamped, MAX := #EngMax);
    #RawValue := REAL_TO_INT(#Norm * 27648.0);
END_FUNCTION_BLOCK
`;

// PID_Compact 多重背景：调节回路（实测：SCL 源里静态声明 PID_Compact 类型即可，
// 不需要先建工艺对象；TIA 编辑器拖入时的 Multi-instance 就是这个类型）
const sclPid = `FUNCTION_BLOCK "Stress_Pid"
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1

VAR_INPUT
   Setpoint : Real;              // 设定值
   ProcessValue : Real;          // 过程值（来自模拟量标定）
   ManualEnable : Bool;          // 手动模式
   ManualValue : Real;           // 手动输出值
   Reset : Bool;                 // 重启控制器
END_VAR

VAR_OUTPUT
   Output : Real;                // PID 输出（送给模拟量输出标定）
   Error : Bool;                 // 错误标志
END_VAR

VAR
   Pid : PID_Compact;            // PID 控制器多重背景实例
END_VAR

BEGIN
    #Pid(Setpoint := #Setpoint,
         Input := #ProcessValue,
         ManualEnable := #ManualEnable,
         ManualValue := #ManualValue,
         Reset := #Reset,
         Output => #Output,
         Error => #Error);
END_FUNCTION_BLOCK
`;

// 泛型计数器 LAD：InOut 区声明 IEC_COUNTER，CTU 的 Instance 指向它（实测唯一通道：
// SCL 源码通道不能驱动泛型计数器，任何调用写法都报 formal parameter invalid）
const ladGenericCounter = `<?xml version="1.0" encoding="utf-8"?>
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
      <Name>Stress_GenericCounter</Name>
      <Namespace />
      <Number>61</Number>
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
</Document>`;

(async () => {
    const cases = [
        { name: 'CTU 计数器(CTU_INT+Q 必须 => 绑定)', src: sclCounter },
        { name: '模拟量输入标定(NORM_X+SCALE_X+断线检测)', src: sclAnalogIn },
        { name: '模拟量输出标定(钳位+反标定)', src: sclAnalogOut },
        { name: 'PID_Compact 调节回路(多重背景)', src: sclPid },
        { name: '泛型计数器 LAD(IEC_COUNTER InOut 实例)', src: ladGenericCounter },
    ];

    for (const c of cases) {
        console.log(`\n===== ${c.name} =====`);
        const r = await importToTia(c.src, true);
        console.log(`  ok=${r.ok} imported=${JSON.stringify(r.imported)}`);
        console.log(`  本块 errors=${r.errorCount} warnings=${r.warningCount} | 项目其他块 errors=${r.otherBlockErrors}`);
        if (!r.ok) {
            (r.messages || []).filter(m => /^Error/i.test(m)).slice(0, 6).forEach(m => console.log('   ' + m));
            if (r.message) console.log('   message: ' + String(r.message).slice(0, 300));
        }
    }
})().finally(() => {
    stopSharedEngineClients();
});
