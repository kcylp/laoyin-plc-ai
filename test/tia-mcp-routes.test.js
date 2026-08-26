const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { backendFiles, readBackendFile, readBackendSource, root } = require('./helpers/backend-source');

const serverSrc = readBackendSource();
const serverEntrySrc = readBackendFile('server.js');
const tiaMcpRoutesSrc = readBackendFile('routes/tia-mcp.js');
const adminRoutesSrc = readBackendFile('routes/admin.js');
const envDiagnoseSrc = readBackendFile('lib/env-diagnose.js');

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
        'web/scaffold-panel.js',
        'web/hardware-panel.js',
        'web/output-panel.js',
        'web/statusbar.js',
        'web/tia-actions.js',
        'web/tree.js',
    ].map(file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n');
}

test('MCP capability layer is wired additively with auth + localOnly', () => {
    for (const file of backendFiles) {
        assert.ok(fs.existsSync(path.join(root, file)), file + ' should exist');
    }
    const lineCount = serverEntrySrc.split(/\r?\n/).length;
    assert.ok(lineCount < 150, 'server.js should be under 150 lines, got ' + lineCount);
    const mcpMount = serverEntrySrc.indexOf("app.use('/api/tia/mcp'");
    const tiaMount = serverEntrySrc.indexOf("app.use('/api/tia'");
    assert.notEqual(mcpMount, -1, 'missing /api/tia/mcp mount');
    assert.notEqual(tiaMount, -1, 'missing /api/tia mount');
    assert.ok(mcpMount < tiaMount, '/api/tia/mcp must mount before /api/tia');

    for (const route of [
        "router.get('/status', authenticateToken, localOnly",
        "router.get('/tools', authenticateToken, localOnly",
        "router.post('/connect', authenticateToken, localOnly",
        "router.post('/call', authenticateToken, localOnly",
        "router.post('/search-hardware', authenticateToken, localOnly",
        "router.post('/tag-tables', authenticateToken, localOnly",
        "router.post('/export-s7dcl', authenticateToken, localOnly",
    ]) {
        assert.ok(tiaMcpRoutesSrc.includes(route), `missing route: ${route}`);
    }
    assert.match(tiaMcpRoutesSrc, /callTool\('SearchHardwareCatalog', \{ keyword, limit \}/);
    assert.match(tiaMcpRoutesSrc, /router\.post\('\/search-hardware'[\s\S]+?mcpEnsureAttached\(client\)[\s\S]+?SearchHardwareCatalog/);
    assert.match(tiaMcpRoutesSrc, /callTool\('GetPlcTagTables', \{ softwarePath \}/);
    assert.match(tiaMcpRoutesSrc, /callTool\('ExportBlocksAsDocuments'/);
    assert.match(tiaMcpRoutesSrc, /callTool\('GetSoftwareTree', \{ softwarePath \}/);
    assert.match(tiaMcpRoutesSrc, /sameName\.length > 1/);
    assert.match(tiaMcpRoutesSrc, /fs\.mkdtempSync/);
    assert.match(tiaMcpRoutesSrc, /\.s7dcl/i);
    assert.match(tiaMcpRoutesSrc, /escapeRegexLiteral/);
    assert.match(tiaMcpRoutesSrc, /'\^' \+ escapeRegexLiteral\(targetName\) \+ '\$'/);
});

test('all TIA-touching operations share one observable mutual-exclusion queue (anti-conflict)', async () => {
    const queue = require('../lib/tia-queue');
    queue._resetForTests();
    let active = 0;
    let maxActive = 0;
    const first = queue.enqueueTiaOp(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active -= 1;
        return 'first';
    }, { label: '旧写入路径', timeoutMs: 1000 });
    const second = queue.enqueueTiaOp(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
        return 'second';
    }, { label: 'MCP 工具路径', timeoutMs: 1000 });
    assert.equal(queue.queueSnapshot().depth >= 1, true);
    assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
    assert.equal(maxActive, 1);
    assert.equal(queue.queueSnapshot().depth, 0);
    // MCP connect 走 AttachToOpenProject,挂同一个已打开的工程
    assert.match(serverSrc, /AttachToOpenProject/);
});

test('MCP tools use a fail-closed confirmation classifier and are audit-logged', () => {
    const { requiresTiaMcpConfirmation } = require('../lib/tia-mcp-helpers');
    assert.equal(requiresTiaMcpConfirmation('GetProject'), false);
    assert.equal(requiresTiaMcpConfirmation('ImportBlock'), true);
    assert.equal(requiresTiaMcpConfirmation('FutureUnknownTool'), true);
    assert.match(serverSrc, /需要 confirmed:true/);
    assert.match(serverSrc, /\[MCP\] 调用 \$\{name\} 用户=/);
});

test('generic MCP call validates the tool name and caps timeout', () => {
    assert.ok(serverSrc.includes('/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)'));
    assert.match(serverSrc, /Math\.min\(Math\.max\(Number\(req\.body\.timeoutMs\)/);
});

test('scaffold endpoint generates spec with OUR model stack, dryRun first, confirmed to execute', () => {
    assert.ok(tiaMcpRoutesSrc.includes("router.post('/scaffold', authenticateToken, localOnly"));
    // spec 生成与聊天同源(llmStream + listUserModels + getCurrentModel)
    assert.match(serverSrc, /await llmStream\(\{/);
    assert.match(serverSrc, /getCurrentModel\(req\.user\.id, models\)/);
    // 先 dryRun:true,confirmed 才 dryRun:false;spec 参数按 MCP schema 传 JSON 文本
    assert.match(serverSrc, /callTool\('ScaffoldProject', \{ spec: specText, dryRun: true \}/);
    assert.match(serverSrc, /callTool\('ScaffoldProject', \{ spec: specText, dryRun: false \}/);
    // requirement 与 spec 二选一
    assert.match(serverSrc, /请提供 requirement\(自然语言\)或 spec\(JSON\)/);
});

test('fusion: env-check reports online engine, shutdown kills MCP child, branding is native', () => {
    assert.match(adminRoutesSrc, /router\.get\('\/env-check', authenticateToken, localOnly/);
    assert.match(adminRoutesSrc, /runDiagnose\(\{ deep, deps: \{ db, \.\.\.envDiagnoseDeps \} \}\)/);
    assert.match(envDiagnoseSrc, /mcp-runtime/);
    assert.match(envDiagnoseSrc, /TiaMcpServer\.exe 缺失/);
    assert.match(serverSrc, /for \(const sig of \['SIGINT', 'SIGTERM', 'exit'\]\)/);
    const scriptSrc = readClientBundle();
    assert.ok(scriptSrc.includes('在线引擎已连接'));
    assert.ok(!scriptSrc.includes('已连接 · MCP'));
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.ok(!indexSrc.includes('MCP 工具'));
    const envSrc = fs.readFileSync(path.join(__dirname, '..', 'env-check.html'), 'utf8');
    assert.ok(envSrc.includes('博途在线引擎'));
});

test('online panel tool area is fully Chinese, mapped to real MCP tool names', () => {
    const scriptSrc = readClientBundle();
    assert.ok(scriptSrc.includes('ONLINE_TOOL_ZH'));
    assert.ok(scriptSrc.includes("'编译诊断': 'CompileAndDiagnosePlc'"));
    assert.ok(scriptSrc.includes("'下载到PLC': 'DownloadToPlc'"));
    // 在线读值用真实存在的工具与参数(ip + itemsJson)
    assert.ok(scriptSrc.includes("name: 'ReadPlcLiveValuesS7'"));
    assert.ok(scriptSrc.includes('itemsJson'));
    assert.ok(!scriptSrc.includes('ReadPlcOnlineValues'));
    for (const [label, tool] of [
        ['HMI 画面设计', 'ApplyUnifiedHmiScreenDesignJson'],
        ['HMI 标签绑定', 'EnsureUnifiedHmiTag'],
        ['HMI 画面导出', 'ExportHmiScreen'],
        ['HMI 画面列表', 'GetHmiScreens'],
        ['HMI 标签预检', 'RunHmiTemplatePlcSyncPrecheckSuite'],
        ['HMI 属性描述', 'DescribeHmiTag'],
    ]) {
        assert.ok(scriptSrc.includes(`'${label}': '${tool}'`), 'missing HMI mapping ' + label + ' -> ' + tool);
    }
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.ok(!indexSrc.includes('如 CompileAndDiagnosePlc'), 'placeholder 不应再是英文工具名');
    assert.ok(indexSrc.includes('选择功能,如 编译诊断'));
    for (const file of ['web/scaffold-panel.js', 'web/hardware-panel.js']) {
        assert.ok(fs.existsSync(path.join(__dirname, '..', file)), file + ' should exist');
    }
    for (const marker of [
        'id="hmiQuickFlow"',
        'id="scaffoldQuickPanel"',
        'id="hardwarePanel"',
        'id="tagTablePanel"',
        'id="odDownloadSection"',
        'id="odLiveReadSection"',
    ]) {
        assert.ok(indexSrc.includes(marker), 'missing online panel marker ' + marker);
    }
    assert.ok(indexSrc.includes('id="outputPanel"'), 'existing collapsed output panel should stay available');
    const ordered = ['hmiQuickFlow', 'scaffoldQuickPanel', 'hardwarePanel', 'odToolsSection', 'tagTablePanel', 'odDownloadSection', 'odLiveReadSection'];
    const positions = ordered.map(id => indexSrc.indexOf('id="' + id + '"'));
    assert.ok(positions.every(pos => pos >= 0), 'all G panel sections should be present');
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'online panel sections should follow the G order');
    assert.ok(scriptSrc.includes('scaffoldPanel.init({ app: this })'));
    assert.ok(scriptSrc.includes('hardwarePanel.init({ app: this })'));
    assert.ok(scriptSrc.includes('/api/tia/mcp/scaffold'));
    assert.ok(scriptSrc.includes('/api/tia/mcp/search-hardware'));
    assert.ok(scriptSrc.includes('/api/tia/mcp/tag-tables'));
    assert.match(scriptSrc, /AddDeviceWithFallback/);
    assert.match(scriptSrc, /state\.spec = null;\s*state\.signature = '';/);
    assert.match(scriptSrc, /!response\.ok \|\| !json \|\| !json\.success \|\| json\.connected === false/);
    assert.match(scriptSrc, /preferredMlfb:\s*item\.articleNumber/);
    assert.match(scriptSrc, /preferredVersion:\s*item\.version/);
    assert.match(scriptSrc, /deviceName:\s*deviceName/);
    assert.match(scriptSrc, /family:\s*family/);
});

test('real software tree endpoint uses PLC-only GetSoftwareTree (no WinCC Unified dependency)', () => {
    assert.ok(tiaMcpRoutesSrc.includes("router.get('/software-tree', authenticateToken, localOnly"));
    assert.match(serverSrc, /async function mcpEnsureAttached\(client\)/);
    assert.match(serverSrc, /callTool\('GetSoftwareTree', \{ softwarePath: 'PLC_1' \}/);
    // 不依赖 GetProjectTree(需要 WinCC Unified 程序集,本机没装)
    const treeSection = tiaMcpRoutesSrc.split("software-tree")[1] || '';
    assert.ok(!treeSection.slice(0, 800).includes('GetProjectTree'));
});

test('scaffold merges into the main composer; download has its own high-risk modal', () => {
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const scriptSrc = readClientBundle();
    // 合并:主输入框有整工程开关,抽屉里的独立建工程输入框已撤
    assert.ok(indexSrc.includes('id="scaffoldMode"'));
    assert.ok(!indexSrc.includes('odScaffoldReq'));
    assert.match(scriptSrc, /async sendScaffold\(message\)/);
    // 下载:独立高危弹窗,必须勾选安全确认;不再用浏览器 confirm 一句话放行
    assert.ok(indexSrc.includes('id="confirmModal"'));
    assert.ok(!indexSrc.includes('id="dlModal"'));
    assert.ok(indexSrc.includes('id="confirmRequiredCheck"'));
    assert.match(scriptSrc, /openDownloadModal\(\)/);
    assert.match(scriptSrc, /import \{ confirmDialog \} from '\.\/confirm-dialog\.js'/);
    assert.match(scriptSrc, /confirmDialog\(\{[\s\S]*title: '下载到 PLC'/);
    assert.match(scriptSrc, /requireCheck: '我已确认现场安全'/);
    assert.ok(!scriptSrc.includes("confirm('确认下载到 PLC"));
});
