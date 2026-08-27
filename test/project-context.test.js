const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    buildProjectContextPrompt,
    createProjectContextService,
    createTiaContextLoader,
    matchRelevantContext,
    summarizeProjectContext,
} = require('../lib/project-context');

const TAG_FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'TASK014_Acceptance_IO.xml'), 'utf8');

const sampleContext = {
    connected: true,
    project: 'ZhuanPan6',
    portalVersion: 'V21',
    plc: { name: 'PLC_1', model: 'CPU 1214C DC/DC/DC', articleNumber: '6ES7 214-1AG40-0XB0', firmware: 'V4.7' },
    blocks: [
        { name: 'Main', type: 'OB1', lang: 'LAD' },
        { name: 'FbSafety', type: 'FC1', lang: 'LAD' },
        { name: 'DbTurn', type: 'DB1', lang: 'DB' },
    ],
    tagTables: [
        {
            name: 'Default tag table',
            variables: [
                { name: 'StartButton', address: '%I0.0', dataType: 'Bool', comment: '启动按钮' },
                { name: 'EmergencyStop', address: '%I0.1', dataType: 'Bool', comment: '急停按钮' },
                { name: 'MotorRun', address: '%Q0.0', dataType: 'Bool', comment: '电机运行' },
            ],
        },
        {
            name: 'Axis tags',
            variables: [
                { name: 'TurnAxis', address: '%DB2', dataType: 'TO_PositioningAxis', comment: '转盘轴' },
            ],
        },
    ],
    technologyObjects: [{ name: 'TurnAxis', type: 'TO_PositioningAxis', db: 'DB2' }],
};

test('summarizeProjectContext builds bounded L1 project summary', () => {
    const summary = summarizeProjectContext(sampleContext, { maxBlocks: 10 });

    assert.match(summary.text, /【当前博途工程】ZhuanPan6 \| 博途 V21 \| CPU 1214C DC\/DC\/DC/);
    assert.match(summary.text, /订货号 6ES7 214-1AG40-0XB0 \| 固件 V4\.7/);
    assert.match(summary.text, /【已有程序块】Main\[OB1,LAD\] FbSafety\[FC1,LAD\] DbTurn\[DB1,DB\]/);
    assert.match(summary.text, /【变量表】共 2 张、4 个变量/);
    assert.match(summary.text, /【工艺对象】TurnAxis\[TO_PositioningAxis, DB2\]/);
    assert.equal(summary.blockCount, 3);
    assert.equal(summary.tableCount, 2);
    assert.equal(summary.variableCount, 4);
    assert.ok(summary.charCount < 900);
});

test('matchRelevantContext injects variables by Chinese and symbol relevance', () => {
    const relevant = matchRelevantContext(sampleContext, '用启动按钮和急停控制电机', { maxVariables: 10 });

    assert.deepEqual(relevant.variables.map(item => item.name), ['StartButton', 'EmergencyStop', 'MotorRun']);
    assert.match(relevant.text, /StartButton \(%I0\.0\) : Bool - 启动按钮/);
    assert.match(relevant.text, /EmergencyStop \(%I0\.1\) : Bool - 急停按钮/);
    assert.match(relevant.text, /MotorRun \(%Q0\.0\) : Bool - 电机运行/);
    assert.equal(relevant.truncated, false);
});

test('buildProjectContextPrompt injects the full tag table only when explicitly requested', () => {
    const normal = buildProjectContextPrompt(sampleContext, { message: '启动电机' });
    assert.doesNotMatch(normal.text, /【完整变量表】/);
    assert.equal(normal.status.explicitVariableCount, 0);

    const explicit = buildProjectContextPrompt(sampleContext, { message: '启动电机', includeAllVariables: true });
    assert.match(explicit.text, /【完整变量表】（用户显式要求注入，4 条）/);
    assert.match(explicit.text, /\[Axis tags\] TurnAxis \(%DB2\) : TO_PositioningAxis - 转盘轴/);
    assert.equal(explicit.status.explicitVariableCount, 4);
    assert.equal(explicit.status.explicitTruncated, false);
});

test('project context service caches reads and invalidates after revision changes', async () => {
    let revision = 1;
    let loadCount = 0;
    const service = createProjectContextService({
        getWriteRevision: () => revision,
        loadContext: async () => {
            loadCount += 1;
            return sampleContext;
        },
    });

    const first = await service.getPromptContext({ userId: 'u1', message: '启动电机' });
    const second = await service.getPromptContext({ userId: 'u1', message: '急停电机' });
    assert.equal(loadCount, 1);
    assert.equal(first.status.cacheHit, false);
    assert.equal(second.status.cacheHit, true);
    assert.match(second.prompt, /EmergencyStop/);

    revision = 2;
    const third = await service.getPromptContext({ userId: 'u1', message: '启动电机' });
    assert.equal(loadCount, 2);
    assert.equal(third.status.cacheHit, false);

    service.invalidate('u1');
    await service.getPromptContext({ userId: 'u1', message: '启动电机' });
    assert.equal(loadCount, 3);
});

test('buildProjectContextPrompt is honest when TIA is not connected', () => {
    const prompt = buildProjectContextPrompt({ connected: false, note: '博途里没有已打开的项目' }, { message: '写一个起保停' });

    assert.match(prompt.text, /【当前博途工程】未连接博途/);
    assert.match(prompt.text, /以下地址为示例/);
    assert.equal(prompt.status.connected, false);
});

test('TIA context loader exports real tag tables and reports a nonzero variable count', async () => {
    const client = {
        callTool: async (name, args) => {
            if (name === 'GetSoftwareTree') return { content: [{ type: 'text', text: JSON.stringify({ tree: 'PLC_1 CPU 1214C' }) }] };
            if (name === 'GetPlcTagTables') return { content: [{ type: 'text', text: JSON.stringify({ items: ['TASK014_Acceptance_IO'] }) }] };
            if (name === 'ExportPlcTagTable') {
                fs.writeFileSync(args.exportPath, TAG_FIXTURE, 'utf8');
                return { content: [{ type: 'text', text: JSON.stringify({ ExportPath: args.exportPath }) }] };
            }
            throw new Error(`unexpected tool ${name}`);
        },
        status: () => ({ tiaMajorVersion: 21 }),
    };
    const load = createTiaContextLoader({
        enqueueTiaOp: fn => fn(),
        mcpEnsureAttached: async () => ({ ok: true, project: 'TASK012A_MC_Oracle' }),
        getMcpClient: () => client,
        parseBlocksFromTree: () => [],
    });

    const context = await load();
    const summary = summarizeProjectContext(context);

    assert.equal(context.warnings.length, 0);
    assert.equal(summary.variableCount, 10);
    assert.match(summary.text, /共 1 张、10 个变量/);
});

test('TIA context loader keeps warning-based degradation when tag export fails', async () => {
    const client = {
        callTool: async (name) => {
            if (name === 'GetSoftwareTree') return { content: [{ type: 'text', text: JSON.stringify({ tree: 'PLC_1' }) }] };
            if (name === 'GetPlcTagTables') return { content: [{ type: 'text', text: JSON.stringify({ items: ['Broken'] }) }] };
            throw new Error('export blocked');
        },
        status: () => ({}),
    };
    const load = createTiaContextLoader({
        enqueueTiaOp: fn => fn(),
        mcpEnsureAttached: async () => ({ ok: true, project: 'Demo' }),
        getMcpClient: () => client,
    });

    const context = await load();

    assert.deepEqual(context.tagTables, []);
    assert.match(context.warnings.join('\n'), /变量表读取失败.*export blocked/);
});
