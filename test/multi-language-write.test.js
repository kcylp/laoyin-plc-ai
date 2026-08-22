// 四种语言的写入通道判定回归测试。
// LAD/FBD 走块级 XML Import；SCL/STL 走 Openness ExternalSources 源码通道。
// 四条链路均已在博途 V21 实机验证（编译 0 错），这里锁住判定逻辑不被改坏。
const test = require('node:test');
const assert = require('node:assert');
const { detectPayloadKind, autoFixDuplicateWirePins, validateLadBusinessRules } = require('../engineer-yin-bridge');

const LAD_XML = '<?xml version="1.0" encoding="utf-8"?>\n<Document><SW.Blocks.FC ID="0"><AttributeList><Name>T</Name><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList></SW.Blocks.FC></Document>';
const SCL_SRC = 'FUNCTION_BLOCK "FB_X"\nVAR_INPUT\n  A : Bool;\nEND_VAR\nBEGIN\n  #A := #A;\nEND_FUNCTION_BLOCK\n';
const STL_SRC = 'FUNCTION_BLOCK "FB_Y"\nVAR_INPUT\n  A : Bool;\nEND_VAR\nBEGIN\nNETWORK\nTITLE = t\n      A     #A;\n      =     #A;\nEND_FUNCTION_BLOCK\n';

test('payload kind routes each language to the right TIA write channel', () => {
    assert.equal(detectPayloadKind(LAD_XML), 'xml');
    assert.equal(detectPayloadKind(SCL_SRC), 'scl');
    assert.equal(detectPayloadKind(STL_SRC), 'stl');

    // 前导注释不应干扰判定
    assert.equal(detectPayloadKind('// motor control\n' + SCL_SRC), 'scl');
    // 空内容不应崩，兜底走 xml 通道由后续校验拦截
    assert.equal(detectPayloadKind(''), 'xml');
});

test('multiple LAD power rails are merged instead of rejected', () => {
    // 博途：「在 LAD 中，程序段中只能包含一个电源线」——AI 给每条并联支路各写一条
    const bad = `<Document><SW.Blocks.FC><AttributeList><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList>
      <FlgNet><Parts>
        <Access UId="31"><Symbol><Component Name="A" /></Symbol></Access>
        <Part Name="Contact" UId="21" /><Part Name="Contact" UId="22" />
        <Part Name="O" UId="25"><TemplateValue Name="Card" Type="Cardinality">2</TemplateValue></Part>
      </Parts><Wires>
        <Wire UId="51"><Powerrail /><NameCon UId="21" Name="in" /></Wire>
        <Wire UId="53"><Powerrail /><NameCon UId="22" Name="in" /></Wire>
        <Wire UId="55"><NameCon UId="21" Name="out" /><NameCon UId="25" Name="in1" /></Wire>
        <Wire UId="56"><NameCon UId="22" Name="out" /><NameCon UId="25" Name="in2" /></Wire>
      </Wires></FlgNet></SW.Blocks.FC></Document>`;

    assert.equal(validateLadBusinessRules(bad).valid, false);

    const fixed = autoFixDuplicateWirePins(bad);
    assert.equal(fixed.changed, true);
    assert.equal((fixed.xml.match(/<Powerrail\b/g) || []).length, 1);
    // 合并后两个支路首触点仍都挂在保留的那条电源线上
    assert.match(fixed.xml, /<Powerrail \/><NameCon UId="21" Name="in" \/><NameCon UId="22" Name="in" \/>/);
    assert.equal(validateLadBusinessRules(fixed.xml).valid, true);
});

test('gates without a cardinality template are rejected', () => {
    // 漏 Card 时博途报 "The node 'TemplateValue' with the name 'Card' ... is missing"
    const noCard = `<Document><SW.Blocks.FC><AttributeList><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList>
      <FlgNet><Parts>
        <Part Name="O" UId="25" />
      </Parts><Wires>
        <Wire UId="51"><Powerrail /><NameCon UId="25" Name="in1" /></Wire>
      </Wires></FlgNet></SW.Blocks.FC></Document>`;
    const r = validateLadBusinessRules(noCard);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.rule === 'GATE_CARDINALITY'));
});

test('source payloads bypass FlgNet wire repair untouched', () => {
    // SCL/STL 没有 FlgNet，接线修复不能改动源码文本
    assert.equal(autoFixDuplicateWirePins(SCL_SRC).changed, false);
    assert.equal(autoFixDuplicateWirePins(SCL_SRC).xml, SCL_SRC);
});

test('TON ET/OpenCon check is order-independent inside a wire', () => {
    // Wire 是端点集合，元素顺序不表达方向。曾用「ET 后面紧跟 OpenCon」的顺序
    // 正则判定，导致合法的 <OpenCon/><NameCon ET/> 写法被误判失败，
    // 带 TON 的程序（如星三角延时切换）会无故被拦下。
    const build = (etWire) => `<Document><SW.Blocks.FC><AttributeList><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList>
      <FlgNet><Parts>
        <Access UId="31" Scope="LocalVariable"><Symbol><Component Name="M" /></Symbol></Access>
        <Access UId="32" Scope="TypedConstant"><Constant><ConstantValue>T#5s</ConstantValue></Constant></Access>
        <Access UId="33" Scope="LocalVariable"><Symbol><Component Name="D" /></Symbol></Access>
        <Part Name="Contact" UId="21" />
        <Part Name="TON" Version="1.0" UId="22"><Instance Scope="LocalVariable" UId="41"><Component Name="T1" /></Instance><TemplateValue Name="time_type" Type="Type">Time</TemplateValue></Part>
        <Part Name="Coil" UId="23" />
      </Parts><Wires>
        <Wire UId="51"><Powerrail /><NameCon UId="21" Name="in" /></Wire>
        <Wire UId="52"><IdentCon UId="31" /><NameCon UId="21" Name="operand" /></Wire>
        <Wire UId="53"><NameCon UId="21" Name="out" /><NameCon UId="22" Name="IN" /></Wire>
        <Wire UId="54"><IdentCon UId="32" /><NameCon UId="22" Name="PT" /></Wire>
        <Wire UId="55"><NameCon UId="22" Name="Q" /><NameCon UId="23" Name="in" /></Wire>
        <Wire UId="56"><IdentCon UId="33" /><NameCon UId="23" Name="operand" /></Wire>
        ${etWire}
      </Wires></FlgNet></SW.Blocks.FC></Document>`;

    const etFirst = build('<Wire UId="57"><NameCon UId="22" Name="ET" /><OpenCon UId="58" /></Wire>');
    const openFirst = build('<Wire UId="57"><OpenCon UId="58" /><NameCon UId="22" Name="ET" /></Wire>');
    assert.equal(validateLadBusinessRules(etFirst).valid, true);
    assert.equal(validateLadBusinessRules(openFirst).valid, true);

    // ET 完全没接 OpenCon 时仍必须报错
    const missing = build('<Wire UId="57"><NameCon UId="22" Name="ET" /><NameCon UId="23" Name="in" /></Wire>');
    const r = validateLadBusinessRules(missing);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.rule === 'TON_ET_OPEN'));
});
