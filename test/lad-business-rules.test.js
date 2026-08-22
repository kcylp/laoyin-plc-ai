const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateLadBusinessRules } = require('../engineer-yin-bridge');

const samples = path.join(__dirname, '..', 'engine', 'samples');

function read(name) {
    return fs.readFileSync(path.join(samples, name), 'utf8');
}

test('accepts the real V21 TON, SCoil, and RCoil export sample', () => {
    const result = validateLadBusinessRules(read('LAD_TON_SR_博途导出.xml'));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('rejects legacy coil names and incomplete TON wiring', () => {
    const xml = read('LAD_TON_SR_验证输入.xml')
        .replace('Version="1.0"', '')
        .replace('<OpenCon UId="34" />', '')
        .replace('Part Name="SCoil"', 'Part Name="CoilSet"');
    const result = validateLadBusinessRules(xml);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.rule === 'TON_VERSION'));
    assert.ok(result.errors.some(error => error.rule === 'TON_ET_OPEN'));
    assert.ok(result.errors.some(error => error.rule === 'COIL_INSTRUCTION'));
});

test('rejects a non-LAD block before TIA preflight', () => {
    const result = validateLadBusinessRules('<Document><ProgrammingLanguage>SCL</ProgrammingLanguage></Document>');
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors.map(error => error.rule), ['LAD_LANGUAGE']);
});

test('rejects counters without Instance or value_type (proven import failures)', () => {
    const base = (part) => `<Document><SW.Blocks.FB><AttributeList><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList>
      <ObjectList><SW.Blocks.CompileUnit><AttributeList><NetworkSource><FlgNet><Parts>
        <Access UId="31" Scope="LocalVariable"><Symbol><Component Name="Pulse" /></Symbol></Access>
        ${part}
      </Parts><Wires>
        <Wire UId="51"><Powerrail /><NameCon UId="21" Name="in" /></Wire>
        <Wire UId="52"><IdentCon UId="31" /><NameCon UId="21" Name="operand" /></Wire>
        <Wire UId="53"><NameCon UId="21" Name="out" /><NameCon UId="22" Name="CU" /></Wire>
        <Wire UId="54"><NameCon UId="22" Name="Q" /><OpenCon UId="55" /></Wire>
        <Wire UId="56"><NameCon UId="22" Name="CV" /><OpenCon UId="57" /></Wire>
      </Wires></FlgNet></NetworkSource></AttributeList></SW.Blocks.CompileUnit></ObjectList></SW.Blocks.FB></Document>`;

    const missingBoth = validateLadBusinessRules(base('<Part Name="Contact" UId="21" /><Part Name="CTU" UId="22"></Part>'));
    assert.equal(missingBoth.valid, false);
    assert.ok(missingBoth.errors.some(error => error.rule === 'CTR_INSTANCE'));
    assert.ok(missingBoth.errors.some(error => error.rule === 'CTR_VALUE_TYPE'));

    const complete = validateLadBusinessRules(base(
        '<Part Name="Contact" UId="21" /><Part Name="CTU" UId="22">' +
        '<Instance Scope="LocalVariable" UId="23"><Component Name="Cnt" /></Instance>' +
        '<TemplateValue Name="value_type" Type="Type">Int</TemplateValue></Part>'));
    assert.ok(!complete.errors.some(error => error.rule.startsWith('CTR_')), JSON.stringify(complete.errors));
});
