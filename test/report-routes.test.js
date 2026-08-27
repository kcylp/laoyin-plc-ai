const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const createReportRoutes = require('../routes/report');
const TAG_FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'TASK014_Acceptance_IO.xml'), 'utf8');

const openDbs = new Set();

test('source server mounts the authenticated delivery report API', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

    assert.match(source, /const createReportRoutes = require\('\.\/routes\/report'\);/);
    assert.match(source, /app\.use\('\/api\/report', createReportRoutes\(deps\)\);/);
});

test('Word COM export removes local Office identity metadata before saving', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'report.js'), 'utf8');

    assert.match(source, /\$document\.RemoveDocumentInformation\(99\)/);
});

async function requestJson(router, method, route, body, userId = 7) {
    const app = express();
    app.use(express.json({ limit: '3mb' }));
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
            method,
            headers: { 'content-type': 'application/json', 'x-user-id': String(userId) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, json: await response.json() };
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

function createDeps({ attached = true, exportWord, compileResult, compileError, tagExportError, softwareTree, knowledgeSearch, aiCapture, aiResponse, models } = {}) {
    const db = new DatabaseSync(':memory:');
    openDbs.add(db);
    db.exec(`CREATE TABLE user_settings (
        user_id INTEGER PRIMARY KEY,
        report_company_name TEXT DEFAULT '',
        report_contact TEXT DEFAULT '',
        report_project_prefix TEXT DEFAULT '',
        updated_at TEXT
    )`);
    const calls = [];
    const client = {
        callTool: async (name, args) => {
            calls.push([name, args]);
            if (name === 'GetProject') return { items: [{ name: '真实工程', attributes: [{ name: 'IsPrimary', value: true }] }] };
            if (name === 'GetSoftwareTree') return { tree: softwareTree || '    ├── PLC_1\n    │   ├── Program blocks\n    │   │   └── Main [OB1, LAD]' };
            if (name === 'GetPlcTagTables') return { items: ['TASK014_Acceptance_IO'] };
            if (name === 'ExportPlcTagTable') {
                if (tagExportError) throw tagExportError;
                fs.writeFileSync(args.exportPath, TAG_FIXTURE, 'utf8');
                return { ExportPath: args.exportPath };
            }
            if (name === 'CompileAndDiagnosePlc') {
                if (compileError) throw compileError;
                return compileResult || { state: 'Success', errorCount: 0, warningCount: 1, rawMessages: ['Warning: real compile output'] };
            }
            throw new Error(`unexpected tool ${name}`);
        },
    };
    const auth = (req, res, next) => { req.user = { id: Number(req.headers['x-user-id'] || 7) }; next(); };
    return {
        db,
        calls,
        authenticateToken: auth,
        localOnly: auth,
        enqueueTiaOp: fn => fn(),
        mcpEnsureAttached: async () => attached ? ({ ok: true, project: '真实工程' }) : ({ ok: false, note: '博途里没有已打开的项目' }),
        getMcpClient: () => client,
        listHistory: userId => [{ id: 1, block_name: 'Main', block_type: 'OB', kind: 'write', overwrite: 1, created_at: '2026-08-27 12:00', user_id: userId }],
        knowledgeService: {
            readKnowledgeDoc: id => ({ id, title: '起保停', content: '### 上机前必须确认\n- 停止按钮接线确认' }),
            searchKnowledge: message => typeof knowledgeSearch === 'function' ? knowledgeSearch(message) : [],
        },
        listUserModels: () => models === undefined ? [{ id: 'model-1', label: 'Test Model' }] : models,
        getCurrentModel: (_userId, available) => available[0] || { id: null, label: '' },
        llmStream: async options => {
            if (typeof aiCapture === 'function') aiCapture(options);
            const output = aiResponse || JSON.stringify({
                overview: 'AI 根据真实工程生成的设备方案概述。',
                operationLogic: 'AI 根据真实程序块和 I/O 生成的操作逻辑。',
            });
            if (typeof options.onDelta === 'function') options.onDelta(output);
            return '';
        },
        ...(exportWord ? { exportWord } : {}),
    };
}

test.afterEach(() => {
    for (const db of openDbs) {
        try { db.close(); } catch { /* already closed */ }
    }
    openDbs.clear();
});

test('report generation refuses to fabricate a document when TIA is not attached', async () => {
    const deps = createDeps({ attached: false });
    const response = await requestJson(createReportRoutes(deps), 'POST', '/generate', {});
    assert.equal(response.status, 409);
    assert.equal(response.json.success, false);
    assert.match(response.json.message, /先连接|挂接|博途/);
});

test('report generation reads real project data and ignores client-supplied compile claims', async () => {
    const deps = createDeps();
    const response = await requestJson(createReportRoutes(deps), 'POST', '/generate', {
        project: { company: 'Acme', projectNumber: 'P-01' },
        usedBlockIds: ['start-stop'],
        compile: { state: 'Success', errorCount: 0, warningCount: 0, rawMessages: ['fabricated client result'] },
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.success, true);
    assert.match(response.json.markdown, /Main/);
    assert.match(response.json.markdown, /%I0\.0/);
    assert.match(response.json.markdown, /停止按钮接线确认/);
    assert.match(response.json.markdown, /Warning: real compile output/);
    assert.doesNotMatch(response.json.markdown, /fabricated client result/);
    assert.deepEqual(deps.calls.map(call => call[0]), ['GetProject', 'GetSoftwareTree', 'GetPlcTagTables', 'ExportPlcTagTable', 'CompileAndDiagnosePlc']);
});

test('report generation stops without producing a document when a real tag table cannot be exported', async () => {
    const deps = createDeps({ tagExportError: new Error('TIA export unavailable') });

    const response = await requestJson(createReportRoutes(deps), 'POST', '/generate', {});

    assert.equal(response.status, 500);
    assert.equal(response.json.success, false);
    assert.match(response.json.message, /变量表|export|导出/i);
    assert.equal(response.json.report, undefined);
    assert.deepEqual(deps.calls.map(call => call[0]), ['GetProject', 'GetSoftwareTree', 'GetPlcTagTables', 'ExportPlcTagTable']);
});

test('report generation stops when the real TIA compile cannot be obtained', async () => {
    const deps = createDeps({ compileError: new Error('TIA compile unavailable') });

    const response = await requestJson(createReportRoutes(deps), 'POST', '/generate', {
        compile: { state: 'Success', errorCount: 0, warningCount: 0 },
    });

    assert.equal(response.status, 500);
    assert.equal(response.json.success, false);
    assert.match(response.json.message, /编译|compile/i);
    assert.deepEqual(deps.calls.map(call => call[0]), ['GetProject', 'GetSoftwareTree', 'GetPlcTagTables', 'ExportPlcTagTable', 'CompileAndDiagnosePlc']);
});

test('report generation detects used knowledge blocks from the real software tree', async () => {
    let searchEvidence = '';
    const deps = createDeps({
        softwareTree: '    ├── PLC_1\n    │   ├── Program blocks\n    │   │   ├── Main [OB1, LAD]\n    │   │   └── StartStop [FC, LAD]',
        knowledgeSearch: message => {
            searchEvidence = message;
            return message.includes('StartStop') ? [{ id: 'start-stop', title: '起保停' }] : [];
        },
    });

    const response = await requestJson(createReportRoutes(deps), 'POST', '/generate', {});

    assert.equal(response.status, 200);
    assert.match(searchEvidence, /StartStop/);
    assert.match(response.json.markdown, /停止按钮接线确认/);
});

test('report AI sections are generated from real project, I/O, compile, and history evidence', async () => {
    let aiRequest;
    const deps = createDeps({ aiCapture: options => { aiRequest = options; } });

    const response = await requestJson(createReportRoutes(deps), 'POST', '/generate', {});

    assert.equal(response.status, 200);
    assert.match(response.json.markdown, /AI 根据真实工程生成的设备方案概述/);
    assert.match(response.json.markdown, /AI 根据真实程序块和 I\/O 生成的操作逻辑/);
    const prompt = aiRequest.messages.map(message => message.content).join('\n');
    assert.match(prompt, /Main/);
    assert.match(prompt, /%I0\.0/);
    assert.match(prompt, /Warning: real compile output/);
    assert.match(prompt, /2026-08-27 12:00/);
});

test('report generation fails clearly when the user has no configured AI model', async () => {
    const deps = createDeps({ models: [] });

    const response = await requestJson(createReportRoutes(deps), 'POST', '/generate', {});

    assert.equal(response.status, 422);
    assert.equal(response.json.success, false);
    assert.match(response.json.message, /模型|设置/);
});

test('company report settings are isolated by authenticated user', async () => {
    const deps = createDeps();
    const router = createReportRoutes(deps);
    let response = await requestJson(router, 'POST', '/settings', { companyName: '甲公司', contact: 'a@example.com' }, 7);
    assert.equal(response.status, 200);
    response = await requestJson(router, 'GET', '/settings', undefined, 8);
    assert.equal(response.status, 200);
    assert.equal(response.json.settings.companyName, '');
    response = await requestJson(router, 'GET', '/settings', undefined, 7);
    assert.equal(response.json.settings.companyName, '甲公司');
    assert.equal(response.json.settings.contact, '<email>');
});

test('export preserves an already generated report model instead of rebuilding empty tables', async () => {
    const deps = createDeps();
    const report = {
        project: { name: '成品报告', company: '甲公司', contact: '', projectNumber: 'P-01' },
        overview: '设备概述',
        operationLogic: '操作逻辑',
        programBlocks: [{ name: 'Main', type: 'OB1', lang: 'LAD', path: 'Program blocks/Main' }],
        ioTags: [{ table: 'Tags', name: 'Start', dataType: 'Bool', logicalAddress: '%I0.0', comment: '启动' }],
        allTags: [{ table: 'Tags', name: 'Start', dataType: 'Bool', logicalAddress: '%I0.0', comment: '启动' }],
        history: [{ blockName: 'Main', blockType: 'OB', operation: '写入', overwrite: true, operator: 'user', createdAt: '2026-08-27' }],
        compile: { summary: 'Success: 0 errors, 0 warnings', rawMessages: [] },
        knowledgeConfirmations: ['停止按钮接线确认'],
        safetyWarning: '安全警示',
        generatedAt: '2026-08-27T00:00:00.000Z',
    };

    const response = await requestJson(createReportRoutes(deps), 'POST', '/export', { format: 'html', report });

    assert.equal(response.status, 200);
    assert.match(response.json.content, /<td>Main<\/td>/);
    assert.match(response.json.content, /<td>%I0\.0<\/td>/);
    assert.match(response.json.content, /2026-08-27/);
});

test('Word export returns a docx payload when the COM exporter succeeds', async () => {
    let exportedHtml = '';
    const deps = createDeps({
        exportWord: async html => {
            exportedHtml = html;
            return Buffer.from('PK fake docx');
        },
    });
    const report = { project: { name: 'Word Project' }, programBlocks: [], ioTags: [], allTags: [], history: [], compile: { rawMessages: [] } };

    const response = await requestJson(createReportRoutes(deps), 'POST', '/export', { format: 'docx', report });

    assert.equal(response.status, 200);
    assert.equal(response.json.format, 'docx');
    assert.equal(response.json.filename, 'plc-delivery-report.docx');
    assert.equal(response.json.encoding, 'base64');
    assert.equal(Buffer.from(response.json.content, 'base64').toString(), 'PK fake docx');
    assert.match(exportedHtml, /Word Project/);
});

test('Word export clearly falls back to printable HTML when COM is unavailable', async () => {
    const deps = createDeps({ exportWord: async () => { throw new Error('Word COM unavailable'); } });
    const report = { project: { name: 'Fallback Project' }, programBlocks: [], ioTags: [], allTags: [], history: [], compile: { rawMessages: [] } };

    const response = await requestJson(createReportRoutes(deps), 'POST', '/export', { format: 'docx', report });

    assert.equal(response.status, 200);
    assert.equal(response.json.format, 'html');
    assert.equal(response.json.fallback, true);
    assert.match(response.json.message, /Word|降级|打印/);
    assert.match(response.json.content, /@media print/);
});
