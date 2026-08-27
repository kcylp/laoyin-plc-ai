'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'TASK014_Acceptance_IO.xml'), 'utf8');

function mcpJson(value) {
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

test('reader parses the observed lowercase ResponseStringList and the exact 10-tag field fixture', async () => {
    const { readAllPlcTags } = require('../lib/plc-tag-reader');
    let exportDir;
    const calls = [];
    const client = {
        callTool: async (name, args) => {
            calls.push([name, args]);
            if (name === 'GetPlcTagTables') return mcpJson({ items: ['TASK014_Acceptance_IO'] });
            exportDir = path.dirname(args.exportPath);
            fs.writeFileSync(args.exportPath, FIXTURE, 'utf8');
            return mcpJson({ ExportPath: args.exportPath });
        },
    };

    const tables = await readAllPlcTags(client, { softwarePath: 'PLC_1' });

    assert.equal(tables.length, 1);
    assert.equal(tables[0].name, 'TASK014_Acceptance_IO');
    assert.deepEqual(tables[0].tags.map(tag => `${tag.name} ${tag.logicalAddress} ${tag.dataType}`), [
        'StartButton %I0.0 Bool', 'StopButton %I0.1 Bool', 'ResetButton %I0.2 Bool',
        'EmergencyOk %I0.3 Bool', 'AutoMode %I0.4 Bool', 'PartSensor %I0.5 Bool',
        'MotorRun %Q0.0 Bool', 'AlarmLamp %Q0.1 Bool', 'ValveExtend %Q0.2 Bool',
        'ValveRetract %Q0.3 Bool',
    ]);
    assert.ok(tables[0].tags.every(tag => tag.comment === ''));
    assert.deepEqual(calls.map(call => call[0]), ['GetPlcTagTables', 'ExportPlcTagTable']);
    assert.equal(calls[1][1].softwarePath, 'PLC_1');
    assert.equal(calls[1][1].tagTableName, 'TASK014_Acceptance_IO');
    assert.equal(fs.existsSync(exportDir), false);
});

test('reader supports uppercase Items, multiple tables, comments, and XML entities', async () => {
    const { readAllPlcTags } = require('../lib/plc-tag-reader');
    const xmlFor = name => `<?xml version="1.0"?><Document><SW.Tags.PlcTagTable><AttributeList><Name>${name}</Name></AttributeList><ObjectList><SW.Tags.PlcTag><AttributeList><DataTypeName>String</DataTypeName><LogicalAddress>%M0.0</LogicalAddress><Name>${name}_Tag</Name><Comment><MultiLanguageTextItems><MultiLanguageText><AttributeList><Culture>zh-CN</Culture><Text>启动 &amp; 停止 &lt;确认&gt;</Text></AttributeList></MultiLanguageText></MultiLanguageTextItems></Comment></AttributeList></SW.Tags.PlcTag></ObjectList></SW.Tags.PlcTagTable></Document>`;
    const exportDirs = [];
    const client = {
        callTool: async (name, args) => {
            if (name === 'GetPlcTagTables') return mcpJson({ Items: ['Table A', 'Table/B'] });
            exportDirs.push(path.dirname(args.exportPath));
            fs.writeFileSync(args.exportPath, xmlFor(args.tagTableName), 'utf8');
            return mcpJson({ exportPath: args.exportPath });
        },
    };

    const tables = await readAllPlcTags(client, { softwarePath: 'PLC_1' });
    assert.deepEqual(tables.map(table => table.name), ['Table A', 'Table/B']);
    assert.equal(tables[0].tags[0].comment, '启动 & 停止 <确认>');
    assert.ok(exportDirs.every(dir => !fs.existsSync(dir)));
});

test('reader parses comments from the real TIA multilingual-text composition', async () => {
    const { readAllPlcTags } = require('../lib/plc-tag-reader');
    const xml = '<?xml version="1.0"?><Document><SW.Tags.PlcTagTable><AttributeList><Name>RealComment</Name></AttributeList><ObjectList><SW.Tags.PlcTag><AttributeList><DataTypeName>Bool</DataTypeName><LogicalAddress>%I0.0</LogicalAddress><Name>StartButton</Name></AttributeList><ObjectList><MultilingualText CompositionName="Comment"><ObjectList><MultilingualTextItem CompositionName="Items"><AttributeList><Culture>zh-CN</Culture><Text>&#x542F;&#x52A8; &amp; &#x505C;&#x6B62;</Text></AttributeList></MultilingualTextItem></ObjectList></MultilingualText></ObjectList></SW.Tags.PlcTag></ObjectList></SW.Tags.PlcTagTable></Document>';
    const client = {
        callTool: async (name, args) => {
            if (name === 'GetPlcTagTables') return mcpJson({ items: ['RealComment'] });
            fs.writeFileSync(args.exportPath, xml, 'utf8');
            return mcpJson({ exportPath: args.exportPath });
        },
    };

    const tables = await readAllPlcTags(client, { softwarePath: 'PLC_1' });
    assert.equal(tables[0].tags[0].comment, '\u542f\u52a8 & \u505c\u6b62');
});

test('reader does not mistake the culture code for an empty TIA comment', async () => {
    const { readAllPlcTags } = require('../lib/plc-tag-reader');
    const xml = '<?xml version="1.0"?><Document><SW.Tags.PlcTagTable><AttributeList><Name>EmptyComment</Name></AttributeList><ObjectList><SW.Tags.PlcTag><AttributeList><DataTypeName>Bool</DataTypeName><LogicalAddress>%I0.0</LogicalAddress><Name>StartButton</Name></AttributeList><ObjectList><MultilingualText CompositionName="Comment"><ObjectList><MultilingualTextItem CompositionName="Items"><AttributeList><Culture>zh-CN</Culture><Text /></AttributeList></MultilingualTextItem></ObjectList></MultilingualText></ObjectList></SW.Tags.PlcTag></ObjectList></SW.Tags.PlcTagTable></Document>';
    const client = {
        callTool: async (name, args) => {
            if (name === 'GetPlcTagTables') return mcpJson({ items: ['EmptyComment'] });
            fs.writeFileSync(args.exportPath, xml, 'utf8');
            return mcpJson({ exportPath: args.exportPath });
        },
    };

    const tables = await readAllPlcTags(client, { softwarePath: 'PLC_1' });
    assert.equal(tables[0].tags[0].comment, '');
});

test('reader returns an empty array only for a valid empty table-name list', async () => {
    const { readAllPlcTags } = require('../lib/plc-tag-reader');
    const client = { callTool: async () => mcpJson({ items: [] }) };
    assert.deepEqual(await readAllPlcTags(client, { softwarePath: 'PLC_1' }), []);
});

test('reader rejects malformed list payloads instead of silently returning no tables', async () => {
    const { readAllPlcTags } = require('../lib/plc-tag-reader');
    const client = { callTool: async () => mcpJson({ message: 'missing list' }) };
    await assert.rejects(() => readAllPlcTags(client, { softwarePath: 'PLC_1' }), /变量表列表响应格式无效/);
});

test('reader preserves export failure cause and removes the temporary directory', async () => {
    const { readAllPlcTags } = require('../lib/plc-tag-reader');
    let exportDir;
    const client = {
        callTool: async (name, args) => {
            if (name === 'GetPlcTagTables') return mcpJson({ items: ['Broken'] });
            exportDir = path.dirname(args.exportPath);
            throw new Error('Openness export denied');
        },
    };

    await assert.rejects(
        () => readAllPlcTags(client, { softwarePath: 'PLC_1' }),
        error => /导出变量表 Broken 失败/.test(error.message) && /Openness export denied/.test(error.message) && error.cause?.message === 'Openness export denied',
    );
    assert.equal(fs.existsSync(exportDir), false);
});

test('reader rejects malformed exported XML and removes the temporary directory', async () => {
    const { readAllPlcTags } = require('../lib/plc-tag-reader');
    let exportDir;
    const client = {
        callTool: async (name, args) => {
            if (name === 'GetPlcTagTables') return mcpJson({ items: ['Malformed'] });
            exportDir = path.dirname(args.exportPath);
            fs.writeFileSync(args.exportPath, '<Document><not-a-tag-table /></Document>', 'utf8');
            return mcpJson({ exportPath: args.exportPath });
        },
    };

    await assert.rejects(() => readAllPlcTags(client, { softwarePath: 'PLC_1' }), /解析变量表 Malformed 失败/);
    assert.equal(fs.existsSync(exportDir), false);
});
