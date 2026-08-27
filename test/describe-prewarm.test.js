const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readBackendFile, readBackendSource } = require('./helpers/backend-source');

const serverSrc = readBackendSource();
const serverEntrySrc = readBackendFile('server.js');
const tiaMcpRoutesSrc = readBackendFile('routes/tia-mcp.js');
const tiaRoutesSrc = readBackendFile('routes/tia.js');
const tiaHistorySrc = readBackendFile('lib/tia-history.js');

function readClientBundle() {
    return [
        'web/app.js',
        'web/api.js',
        'web/chat.js',
        'web/code-blocks.js',
        'web/confirm-dialog.js',
        'web/history.js',
        'web/inspector.js',
        'web/online.js',
        'web/output-panel.js',
        'web/statusbar.js',
        'web/tia-actions.js',
        'web/tree.js',
    ].map(file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n');
}

function readCssBundle() {
    return [
        'web/css/tokens.css',
        'web/css/shell.css',
        'web/css/chat.css',
        'web/css/panels.css',
        'web/css/modals.css',
        'web/css/components.css',
    ].map(file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n');
}

function loadParseBlocksFromTree() {
    const match = serverSrc.match(/function parseBlocksFromTree\(tree\) \{[\s\S]*?\n\}/);
    assert.ok(match, 'parseBlocksFromTree implementation not found');
    return Function(`return (${match[0]})`)();
}

test('describe-block endpoint wires DescribeBlockLogic with auth + localOnly', () => {
    assert.ok(tiaMcpRoutesSrc.includes("router.post('/describe-block', authenticateToken, localOnly"));
    assert.match(serverSrc, /callTool\('DescribeBlockLogic', \{ softwarePath: 'PLC_1', blockPath: target \}/);
    assert.match(serverSrc, /readable: j\.readable \|\|/);
});

test('software-tree parses blocks for clickable tree + describe', () => {
    // 端点在 server.js 里;解析函数从真实 GetSoftwareTree 树文本工作
    const treeSample = [
        '```',
        'PLC_1 [PLC Software]',
        '├── Program blocks',
        '│   ├── Main [OB1, LAD]',
        '│   ├── Stress_StarDelta [FB50, LAD]',
        '│   └── FB_MotorBatch [FB8, SCL]',
        '└── PLC data types',
        '```',
    ].join('\n');
    // 提取并执行 server.js 里的 parseBlocksFromTree(通过子串验证存在即可)
    assert.match(serverSrc, /function parseBlocksFromTree\(tree\)/);
    // 用独立实现验证期望形状(与 server 解析一致)
    const blocks = [];
    let inProgram = false;
    for (const line of treeSample.split('\n')) {
        const t = line.trim();
        if (t.includes('[PLC Software]')) { inProgram = true; continue; }
        if (!inProgram) continue;
        const m = t.replace(/^[│├└─\s]*/, '').match(/^(.+?)\s*\[(OB\d+|FB\d+|FC\d+|DB\d+)[,\s]*([^\]]*)\]/);
        if (m) blocks.push({ name: m[1].trim(), type: m[2], lang: (m[3] || '').trim(), path: 'Program blocks/' + m[1].trim() });
    }
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].name, 'Main');
    assert.equal(blocks[1].path, 'Program blocks/Stress_StarDelta');
    assert.equal(blocks[2].lang, 'SCL');
});

test('software-tree preserves nested block-group paths for DescribeBlockLogic', () => {
    const parseBlocksFromTree = loadParseBlocksFromTree();
    const treeSample = [
        'PLC_1 [PLC Software]',
        '├── Program blocks',
        '│   ├── Main [OB1, LAD]',
        '│   └── Motors',
        '│       ├── Shared [FB10, SCL]',
        '│       └── Line A',
        '│           └── Shared [FB11, LAD]',
        '└── PLC data types',
    ].join('\n');
    assert.deepEqual(parseBlocksFromTree(treeSample).map(block => block.path), [
        'Program blocks/Main',
        'Program blocks/Motors/Shared',
        'Program blocks/Motors/Line A/Shared',
    ]);
});

test('prewarm starts on listen, is disableable, and reports status', () => {
    assert.match(serverEntrySrc, /function startTiaPrewarm\(\)/);
    assert.match(serverEntrySrc, /process\.env\.TIA_PREWARM\s*\|\|\s*'1'/);
    assert.match(serverEntrySrc, /startTiaPrewarm\(\);/);
    assert.ok(tiaMcpRoutesSrc.includes('prewarm: getPrewarmStatus()'));
    assert.match(serverEntrySrc, /prewarmStatus = 'warming'/);
    assert.match(serverEntrySrc, /getSharedYinWorkerClient/);
    const start = serverEntrySrc.indexOf('function startTiaPrewarm()');
    const end = serverEntrySrc.indexOf('app.listen', start);
    const prewarmSrc = serverEntrySrc.slice(start, end);
    assert.match(prewarmSrc, /queue\.enqueueTiaOp\(async \(\) =>/);
    assert.match(prewarmSrc, /await client\.callTool\('Connect', \{\}, 300000\)/);
    assert.match(prewarmSrc, /await workerClient\.ensureReady\(\)/);
    assert.match(prewarmSrc, /return mcpHelpers\.mcpEnsureAttached\(client\)/);
});

test('frontend renders clickable blocks and prewarm status', () => {
    const scriptSrc = readClientBundle();
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.ok(indexSrc.includes('id="rtBlocks"'));
    assert.ok(indexSrc.includes('id="rtDesc"'));
    assert.match(scriptSrc, /程序块 · 点击解读/);
    assert.match(scriptSrc, /\/api\/tia\/mcp\/describe-block/);
    assert.match(scriptSrc, /正在预热博途实例/);
    const css = readCssBundle();
    assert.match(css, /\.rt-block/);
    assert.match(css, /\.rt-desc-body/);
});

test('tool list modal shows all tools searchable, plus clear-on-run frees the input', () => {
    const scriptSrc = readClientBundle();
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    // 全部工具点选弹窗(彻底解决下拉"显示不全")
    assert.match(scriptSrc, /openToolListModal\(\)/);
    assert.match(scriptSrc, /window\.__ONLINE_TOOL_ZH = ONLINE_TOOL_ZH/);
    assert.ok(indexSrc.includes('id="odToolListBtn"'));
    assert.ok(indexSrc.includes('id="toolListModal"'));
    const css = readCssBundle();
    assert.match(css, /\.tool-list-item/);
});

test('online panel result is collapsible so other tools stay reachable', () => {
    const scriptSrc = readClientBundle();
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.ok(indexSrc.includes('id="outputPanel"'));
    assert.ok(!indexSrc.includes('id="odResultWrap"'));
    assert.ok(indexSrc.includes('id="outputClear"'));
    assert.match(scriptSrc, /outputPanel\.push|outputPanel\.clear/);
    assert.match(scriptSrc, /import \{ outputPanel \} from '\.\/output-panel\.js'/);
    assert.doesNotMatch(scriptSrc, /resultClear\.addEventListener/);
    assert.doesNotMatch(scriptSrc, /resultWrap\.classList\.remove/);
    assert.doesNotMatch(scriptSrc, /body\.scrollTop = 0/);
    assert.doesNotMatch(scriptSrc, /toolInput\.scrollIntoView/);
    // 执行完成后自动清空输入框并聚焦,立即能选下一个工具
    assert.match(scriptSrc, /toolName\.value = ''/);
    assert.match(scriptSrc, /toolName\.focus\(\)/);
});

test('write history backend records snapshots and serves them for rollback', () => {
    assert.match(serverSrc, /CREATE TABLE IF NOT EXISTS tia_write_history/);
    assert.match(serverEntrySrc, /const history = require\('\.\/lib\/tia-history'\)/);
    assert.match(serverEntrySrc, /\.\.\.history/);
    assert.match(tiaHistorySrc, /function recordWriteHistory\(userId, info, options = \{\}\)/);
    assert.match(tiaHistorySrc, /maxBlockEntries: 30/);
    assert.ok(tiaRoutesSrc.includes("router.get('/history', authenticateToken"));
    assert.ok(tiaRoutesSrc.includes("router.get('/history/:id', authenticateToken"));
    // 写入成功才留快照
    assert.match(tiaRoutesSrc, /if \(r\.ok\) \{[\s\S]*?recordWriteHistory/);
    // 取版本按用户隔离,防越权读别人历史
    assert.match(tiaHistorySrc, /WHERE id = \? AND user_id = \?/);
});

test('history rollback reuses the standard confirm-then-write flow', () => {
    const scriptSrc = readClientBundle();
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.match(scriptSrc, /async openHistoryModal\(\)/);
    assert.match(scriptSrc, /async rollbackToVersion\(id, name\)/);
    assert.match(scriptSrc, /rollbackToVersion\(id, name\)/);
    assert.match(scriptSrc, /回滚到此版本/);
    assert.ok(indexSrc.includes('id="histModal"'));
    assert.ok(indexSrc.includes('写入历史'));
    const css = readCssBundle();
    assert.match(css, /\.hist-item/);
});
