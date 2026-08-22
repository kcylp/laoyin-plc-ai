const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = process.cwd();
const SHOT_DIR = process.env.UX_SHOT_DIR
    ? path.resolve(ROOT, process.env.UX_SHOT_DIR)
    : path.join(ROOT, 'work', 'ux-verify');
const RESULT_FILE = path.join(SHOT_DIR, 'verify-results.json');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const LAD_XML = '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<Document><ProgrammingLanguage>LAD</ProgrammingLanguage><FlgNet><Part Name="Contact" /></FlgNet><Title>UX_Write_Block</Title></Document>';

fs.rmSync(SHOT_DIR, { recursive: true, force: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

const state = {
    writeDone: false,
    importCount: 0,
    callCount: 0,
    requests: [],
    gCalls: [],
};
const results = {};

function record(key, ok, detail = '') {
    results[key] = { ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            if (!body) return resolve({});
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

function sendJson(res, obj, status = 200) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function sendSse(res, content) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
    });
    res.write('data: ' + JSON.stringify({ type: 'delta', content }) + '\n\n');
    res.write('data: ' + JSON.stringify({ type: 'done', content }) + '\n\n');
    res.end();
}

function workbenchStatus() {
    return {
        user: { name: 'ux-worker', status: 'approved' },
        registration: { approvalRequired: false },
        ai: {
            ready: true,
            providerCount: 1,
            modelCount: 1,
            currentModelLabel: 'Mock PLC Model',
            currentModelTestStatus: 'passed',
            currentModelTestMessage: 'Mock model ready',
        },
        tia: { mode: 'mock-online' },
        runtime: { node: process.version },
        mail: { configured: false },
        schemaCount: 27,
    };
}

function softwareTree() {
    const blocks = [
        { name: 'Stress_StarDelta', path: '/plc/Stress_StarDelta', lang: 'LAD', type: 'FC' },
    ];
    if (state.writeDone) blocks.push({ name: 'UX_Write_Block', path: '/plc/UX_Write_Block', lang: 'LAD', type: 'FC' });
    return {
        success: true,
        connected: true,
        tree: ['MockProject', '  PLC_1', '    Program blocks'].concat(blocks.map(b => '      ' + b.name + ' [' + b.lang + ']')).join('\n'),
        blocks,
    };
}

function contentType(file) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.html') return 'text/html; charset=utf-8';
    if (ext === '.js') return 'text/javascript; charset=utf-8';
    if (ext === '.css') return 'text/css; charset=utf-8';
    if (ext === '.json') return 'application/json; charset=utf-8';
    if (ext === '.png') return 'image/png';
    return 'application/octet-stream';
}

function serveStatic(urlPath, res) {
    const clean = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
    const resolved = path.resolve(ROOT, clean.replace(/^\/+/, ''));
    if (!resolved.startsWith(path.resolve(ROOT) + path.sep) && resolved !== path.resolve(ROOT)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        res.writeHead(404);
        return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': contentType(resolved), 'Cache-Control': 'no-store' });
    fs.createReadStream(resolved).pipe(res);
}

async function route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    state.requests.push(req.method + ' ' + url.pathname);
    if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/api/verify') return sendJson(res, { success: true });
    if (req.method === 'GET' && url.pathname === '/api/models') {
        return sendJson(res, { success: true, currentModelId: 'mock-model', models: [{ id: 'mock-model', label: 'Mock PLC Model' }] });
    }
    if (req.method === 'POST' && url.pathname === '/api/models/current') return sendJson(res, { success: true, currentModelId: 'mock-model' });
    if (req.method === 'GET' && url.pathname === '/api/workbench/status') return sendJson(res, { success: true, status: workbenchStatus() });
    if (req.method === 'POST' && url.pathname === '/api/chat/clear') return sendJson(res, { success: true });

    if (req.method === 'POST' && url.pathname === '/api/chat') {
        await readBody(req).catch(() => ({}));
        return sendSse(res, 'Mock LAD block generated.\n```xml\n' + LAD_XML + '\n```');
    }
    if (req.method === 'POST' && url.pathname === '/api/validate') return sendJson(res, { success: true, valid: true, errors: [] });

    if (req.method === 'POST' && url.pathname === '/api/tia/preflight') {
        await readBody(req).catch(() => ({}));
        return sendJson(res, {
            success: true,
            tiaVersion: 'V21',
            project: 'MockProject',
            plc: 'PLC_1',
            blockType: 'FC',
            blockName: 'UX_Write_Block',
            language: 'lad',
            existingCount: 0,
            nameTaken: false,
            confirmationToken: 'ux-token-' + Date.now(),
        });
    }
    if (req.method === 'POST' && url.pathname === '/api/tia/import') {
        const body = await readBody(req).catch(() => ({}));
        state.writeDone = true;
        state.importCount += 1;
        return sendJson(res, {
            success: true,
            stage: 'done',
            imported: ['UX_Write_Block'],
            blockName: 'UX_Write_Block',
            errorCount: 0,
            warningCount: 0,
            messages: ['Mock compile OK', 'Confirmed=' + String(body.confirmed === true)],
        });
    }
    if (req.method === 'GET' && url.pathname === '/api/tia/history') {
        return sendJson(res, {
            success: true,
            history: [{ id: 1, block_name: 'UX_Write_Block', block_type: 'FC', kind: 'xml', language: 'LAD', overwrite: false, created_at: '2026-08-06T00:00:00Z' }],
        });
    }
    if (req.method === 'GET' && url.pathname === '/api/tia/history/1') {
        return sendJson(res, { success: true, version: { id: 1, blockName: 'UX_Write_Block', content: LAD_XML } });
    }

    if (req.method === 'GET' && url.pathname === '/api/tia/mcp/status') {
        return sendJson(res, { available: true, running: true, initialized: true, prewarm: 'ready', serverInfo: { version: 'mock-v21' } });
    }
    if (req.method === 'GET' && url.pathname === '/api/tia/mcp/software-tree') return sendJson(res, softwareTree());
    if (req.method === 'POST' && url.pathname === '/api/tia/mcp/describe-block') {
        const body = await readBody(req).catch(() => ({}));
        return sendJson(res, {
            success: true,
            blockName: body.name || 'Stress_StarDelta',
            language: 'LAD',
            readable: 'MotorRun := Start AND NOT Stop; StarContactor := MotorRun AND TimerDone; DeltaContactor := MotorRun AND NOT StarContactor;',
        });
    }
    if (req.method === 'POST' && url.pathname === '/api/tia/mcp/connect') return sendJson(res, { success: true, connected: true });
    if (req.method === 'GET' && url.pathname === '/api/tia/mcp/tools') {
        return sendJson(res, { success: true, tools: [{ name: 'CompileAndDiagnosePlc' }, { name: 'GetSoftwareTree' }, { name: 'GetHmiScreens' }, { name: 'ReadPlcLiveValuesS7' }, { name: 'DownloadToPlc' }, { name: 'DeleteBlock' }] });
    }
    if (req.method === 'POST' && url.pathname === '/api/tia/mcp/call') {
        const body = await readBody(req).catch(() => ({}));
        state.callCount += 1;
        state.gCalls.push({ route: 'call', body });
        const name = body.name || '';
        if (/DownloadToPlc|DeleteBlock/i.test(name) && body.confirmed !== true) {
            return sendJson(res, { success: false, dangerous: true, message: 'Dangerous call requires confirmation' });
        }
        if (/ReadPlc/i.test(name)) {
            return sendJson(res, { success: true, json: { rows: [{ name: 'M0.0', value: true }, { name: 'DB1.DBD0', value: 12.5 }] } });
        }
        if (name === 'GetHmiScreens') return sendJson(res, { success: true, json: { screens: ['Overview', 'Diagnostics'] } });
        if (/GetSoftwareTree/i.test(name)) return sendJson(res, { success: true, json: softwareTree() });
        return sendJson(res, { success: true, json: { compiled: true, errorCount: 0, warningCount: 0, call: name || 'unknown' } });
    }
    if (req.method === 'POST' && url.pathname === '/api/tia/mcp/scaffold') {
        const body = await readBody(req).catch(() => ({}));
        state.gCalls.push({ route: 'scaffold', body });
        if (body.confirmed) return sendJson(res, { success: true, runReport: 'Mock project created, compiled, and saved.' });
        return sendJson(res, {
            success: true,
            specSource: 'mock',
            spec: { projectName: 'UXPlant', plcName: 'PLC_1', hmiName: 'HMI_1', udt: [{ name: 'UDT_Status' }], globalDb: [], tagTable: [{ name: 'Tags' }] },
            dryReport: 'Dry run OK: hardware, tags, blocks, and HMI screens validated.',
        });
    }
    if (req.method === 'POST' && url.pathname === '/api/tia/mcp/search-hardware') {
        const body = await readBody(req).catch(() => ({}));
        state.gCalls.push({ route: 'search-hardware', body });
        return sendJson(res, {
            success: true,
            keyword: body.keyword || '',
            count: 1,
            items: [{
                articleNumber: '6ES7511-1AK02-0AB0',
                description: 'CPU 1511-1 PN',
                typeName: 'CPU 1511-1 PN',
                version: 'V2.9',
                insertable: true,
            }],
        });
    }
    if (req.method === 'POST' && url.pathname === '/api/tia/mcp/tag-tables') {
        const body = await readBody(req).catch(() => ({}));
        state.gCalls.push({ route: 'tag-tables', body });
        return sendJson(res, {
            success: true,
            connected: true,
            tables: [{
                Name: 'ProcessTags',
                Tags: [{ Name: 'MotorRun', DataType: 'Bool', Address: '%M0.0' }],
            }],
        });
    }
    if (req.method === 'POST' && url.pathname === '/api/tia/mcp/export-s7dcl') {
        const body = await readBody(req).catch(() => ({}));
        state.gCalls.push({ route: 'export-s7dcl', body });
        return sendJson(res, {
            success: true,
            filename: (body.name || 'Stress_StarDelta') + '.s7dcl',
            content: 'FUNCTION "Stress_StarDelta" : Void\nBEGIN\nEND_FUNCTION\n',
        });
    }

    if (req.method === 'GET') return serveStatic(url.pathname, res);
    res.writeHead(404);
    res.end('Not found');
}

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

class CDP {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        ws.onmessage = ev => {
            const msg = JSON.parse(ev.data);
            if (msg.id && this.pending.has(msg.id)) {
                const item = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? item.reject(new Error(msg.error.message)) : item.resolve(msg.result || {});
            }
        };
    }
    static async connect(wsUrl) {
        const ws = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        return new CDP(ws);
    }
    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async eval(expression) {
        const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800));
        return r.result ? r.result.value : undefined;
    }
    async navigate(url) {
        await this.send('Page.navigate', { url });
    }
    async viewport(width, height) {
        await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await sleep(350);
    }
    async shot(name) {
        const png = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(png.data, 'base64'));
    }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitFor(cdp, expression, timeoutMs = 10000) {
    const start = Date.now();
    let last;
    while (Date.now() - start < timeoutMs) {
        last = await cdp.eval(expression).catch(e => ({ error: e.message }));
        if (last) return last;
        await sleep(250);
    }
    throw new Error('Timeout waiting for: ' + expression + ' last=' + JSON.stringify(last));
}

function jsString(value) { return JSON.stringify(value); }

async function click(cdp, selector) {
    await cdp.eval(`(() => { const el = document.querySelector(${jsString(selector)}); if (!el) throw new Error('Missing selector ${selector}'); el.click(); return true; })()`);
    await sleep(250);
}

async function setValue(cdp, selector, value) {
    await cdp.eval(`(() => { const el = document.querySelector(${jsString(selector)}); if (!el) throw new Error('Missing selector ${selector}'); el.value = ${jsString(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
}

async function noHorizontalScroll(cdp, label, width, height) {
    await cdp.viewport(width, height);
    await sleep(400);
    const metrics = await cdp.eval(`(() => ({ width: window.innerWidth, body: document.body.scrollWidth, doc: document.documentElement.scrollWidth, ok: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) <= window.innerWidth + 2 }))()`);
    record(label, metrics && metrics.ok, metrics);
    return metrics;
}

async function runBrowser(baseUrl) {
    const chromePort = await new Promise(resolve => {
        const s = require('node:net').createServer();
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    const profile = path.join(os.tmpdir(), 'laoyin-c-ux-' + Date.now());
    const chrome = spawn(CHROME, [
        '--headless=new',
        '--remote-debugging-port=' + chromePort,
        '--remote-allow-origins=*',
        '--no-first-run',
        '--disable-gpu',
        '--window-size=1280,800',
        '--user-data-dir=' + profile,
        'about:blank',
    ], { stdio: 'ignore' });

    try {
        let targets = [];
        for (let i = 0; i < 60; i++) {
            try {
                const r = await fetch('http://127.0.0.1:' + chromePort + '/json/list');
                targets = await r.json();
                if (targets.length) break;
            } catch (_) {}
            await sleep(250);
        }
        if (!targets.length) throw new Error('Chrome CDP did not start');
        const cdp = await CDP.connect(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
        const consoleIssues = [];
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        cdp.ws.addEventListener('message', ev => {
            try {
                const msg = JSON.parse(ev.data);
                if (msg.method === 'Runtime.exceptionThrown') {
                    consoleIssues.push('EX ' + msg.params.exceptionDetails.text);
                }
                if (msg.method === 'Runtime.consoleAPICalled' && ['error'].includes(msg.params.type)) {
                    consoleIssues.push('CONSOLE ' + msg.params.args.map(arg => arg.value || arg.description || '').join(' '));
                }
            } catch (_) {}
        });
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
            source: "localStorage.setItem('token','ux-token'); localStorage.setItem('user', JSON.stringify({ username: 'ux-worker' })); localStorage.setItem('plcSeries','s1200'); localStorage.setItem('plcLang','lad');",
        });

        await cdp.viewport(1280, 800);
        await cdp.navigate(baseUrl + '/index.html');
        await waitFor(cdp, `window.plcAssistant && document.querySelector('#sendButton') && document.querySelector('#inspector')`, 12000);
        await waitFor(cdp, `document.querySelector('#modelSelect') && document.querySelector('#modelSelect').options.length > 0`, 8000);
        await sleep(700);
        await cdp.shot('01-shell.png');
        record('01_shell_loaded', await cdp.eval(`!!(window.plcAssistant && document.querySelector('#outputPanel.collapsed') && document.querySelector('#onlinePanel.hidden'))`));
        await noHorizontalScroll(cdp, 'no_horizontal_scroll_1280x800', 1280, 800);

        await setValue(cdp, '#userInput', 'LAD motor start stop block for TIA');
        await click(cdp, '#sendButton');
        await waitFor(cdp, `document.querySelector('.send-tia')`, 12000);
        record('global_onclick_exports', await cdp.eval(`['copyCode','downloadXml','validateXml','sendToTia'].every(name => typeof window[name] === 'function')`));
        await click(cdp, '.send-tia');
        await waitFor(cdp, `(() => { const m = document.querySelector('#confirmModal:not(.hidden)'); return m && m.dataset.level === 'info' && document.querySelectorAll('#confirmFacts tr').length >= 4; })()`, 8000);
        await cdp.shot('02-confirm-info.png');
        record('02_confirm_info', await cdp.eval(`document.querySelector('#confirmModal').dataset.level === 'info' && document.querySelectorAll('#confirmFacts tr').length >= 4`));
        await click(cdp, '#confirmOk');
        await waitFor(cdp, `document.querySelector('#outputTitle') && /\\([1-9]/.test(document.querySelector('#outputTitle').textContent)`, 10000);
        await waitFor(cdp, `document.querySelector('#rtBlocks') && document.querySelector('#rtBlocks').textContent.includes('UX_Write_Block')`, 10000);
        await click(cdp, '#outputToggle');
        await sleep(500);
        await cdp.shot('03-output.png');
        const writeState = await cdp.eval(`(() => ({ output: document.querySelector('#outputList').textContent, inspector: document.querySelector('#inspector').textContent, tree: document.querySelector('#rtBlocks').textContent }))()`);
        record('03_output_write_result', writeState.output.includes('UX_Write_Block') && writeState.output.includes('0'), writeState.output.slice(0, 300));
        record('write_result_inspector', writeState.inspector.includes('UX_Write_Block') && writeState.inspector.includes('0'), writeState.inspector.slice(0, 300));
        record('tree_auto_refresh', writeState.tree.includes('UX_Write_Block'), writeState.tree);
        await cdp.shot('04-tree-auto.png');

        await click(cdp, '#rtBlocks [data-name="Stress_StarDelta"]');
        await waitFor(cdp, `document.querySelector('#rtDesc') && !document.querySelector('#rtDesc').classList.contains('hidden') && document.querySelector('#inspector').textContent.includes('MotorRun')`, 10000);
        await cdp.shot('05-describe.png');
        record('05_block_logic_inspector', await cdp.eval(`document.querySelector('#inspector').textContent.includes('MotorRun')`));

        await click(cdp, '[data-tree-hist]');
        await waitFor(cdp, `document.querySelector('#histModal:not(.hidden)') && document.querySelector('[data-rollback]')`, 8000);
        await cdp.shot('06-history.png');
        await click(cdp, '[data-rollback]');
        await waitFor(cdp, `document.querySelector('#confirmModal:not(.hidden)') && document.querySelector('#confirmModal').dataset.level === 'warn'`, 8000);
        await cdp.shot('07-confirm-warn.png');
        record('07_rollback_warn_confirm', await cdp.eval(`document.querySelector('#confirmModal').dataset.level === 'warn' && document.querySelector('#confirmTitle').textContent.length > 0`));
        await click(cdp, '#confirmOk');
        await waitFor(cdp, `document.querySelector('#outputList').textContent.includes('UX_Write_Block')`, 10000);

        await click(cdp, '#btnTiaOnline');
        await waitFor(cdp, `document.querySelector('#onlinePanel') && !document.querySelector('#onlinePanel').classList.contains('hidden')`, 8000);
        await sleep(400);
        await cdp.shot('08-online-full.png');
        record('08_online_fullpanel', await cdp.eval(`!!document.querySelector('#onlinePanel:not(.hidden)') && !document.querySelector('#tiaOnlineDrawer')`));
        record('g_layout_order', await cdp.eval(`(() => {
            const ids = ['hmiQuickFlow','scaffoldQuickPanel','hardwarePanel','odToolsSection','tagTablePanel','odDownloadSection','odLiveReadSection'];
            const positions = ids.map(id => {
                const el = document.getElementById(id);
                return el ? el.getBoundingClientRect().top + document.querySelector('.fullpanel-body').scrollTop : -1;
            });
            return positions.every((value, index) => value >= 0 && (index === 0 || value > positions[index - 1]));
        })()`));
        await cdp.shot('13-g-layout-top.png');

        await setValue(cdp, '#scaffoldProjectName', 'UXPlant');
        await setValue(cdp, '#scaffoldRequirement', 'S7-1500 电机启停工程，预览并 dryRun 校验');
        await click(cdp, '#scaffoldPreview');
        await waitFor(cdp, `document.querySelector('#scaffoldPreviewBox').textContent.includes('UXPlant') && document.querySelector('#scaffoldPreviewBox').textContent.includes('Dry run OK')`, 10000);
        await cdp.shot('14-g-scaffold-preview.png');
        record('g1_scaffold_dry_run', state.gCalls.some(call => call.route === 'scaffold' && call.body.confirmed === false && /UXPlant/.test(call.body.requirement || '')));

        await setValue(cdp, '#odToolName', 'HMI 画面列表');
        await setValue(cdp, '#odArgs', '{}');
        await click(cdp, '#odCall');
        await waitFor(cdp, `document.querySelector('#outputList').textContent.includes('GetHmiScreens') && document.querySelector('#outputList').textContent.includes('Overview')`, 10000);
        record('g2_hmi_readonly_call', state.gCalls.some(call => call.route === 'call' && call.body.name === 'GetHmiScreens' && call.body.confirmed === false));

        await setValue(cdp, '#hardwareKeyword', 'CPU 1511');
        await click(cdp, '#hardwareSearchBtn');
        await waitFor(cdp, `document.querySelector('#hardwareResults [data-add-hardware]') && document.querySelector('#hardwareResults').textContent.includes('6ES7511')`, 10000);
        await cdp.shot('15-g-hardware-results.png');
        record('g3_hardware_search_readonly', state.gCalls.some(call => call.route === 'search-hardware' && call.body.keyword === 'CPU 1511' && call.body.limit === 50));

        await cdp.eval(`document.querySelector('.fullpanel-body').scrollTop = document.querySelector('.fullpanel-body').scrollHeight`);
        await sleep(400);
        await click(cdp, '#tagTablesRefresh');
        await waitFor(cdp, `document.querySelector('#tagTablesList [data-tag-table]') && document.querySelector('#tagTablesList').textContent.includes('ProcessTags')`, 10000);
        await click(cdp, '#tagTablesList [data-tag-table]');
        await waitFor(cdp, `document.querySelector('#inspector').textContent.includes('ProcessTags') && document.querySelector('#inspector').textContent.includes('MotorRun')`, 8000);
        await cdp.shot('16-g-tag-tables-bottom.png');
        record('g4_tag_tables_readonly', state.gCalls.some(call => call.route === 'tag-tables' && call.body.softwarePath === 'PLC_1'));

        await setValue(cdp, '#odToolName', 'CompileAndDiagnosePlc');
        await setValue(cdp, '#odArgs', '{}');
        await click(cdp, '#odCall');
        await waitFor(cdp, `document.activeElement && document.activeElement.id === 'odToolName' && document.querySelector('#odToolName').value === ''`, 10000);
        await cdp.shot('09-tool-result.png');
        record('09_tool_result_output', await cdp.eval(`document.querySelector('#outputList').textContent.includes('CompileAndDiagnosePlc')`));
        record('tool_ready_for_next_search', await cdp.eval(`document.activeElement.id === 'odToolName' && document.querySelector('#odToolName').value === ''`));

        await noHorizontalScroll(cdp, 'no_horizontal_scroll_1100x700', 1100, 700);
        await setValue(cdp, '#odToolName', 'GetSoftwareTree');
        await setValue(cdp, '#odArgs', '{}');
        await click(cdp, '#odCall');
        await waitFor(cdp, `document.activeElement && document.activeElement.id === 'odToolName' && document.querySelector('#odToolName').value === ''`, 10000);
        await cdp.shot('10-tool-again.png');
        record('10_small_tool_again', await cdp.eval(`document.querySelector('#outputList').textContent.includes('GetSoftwareTree') && document.activeElement.id === 'odToolName'`));

        await click(cdp, '#odDownload');
        await waitFor(cdp, `document.querySelector('#confirmModal:not(.hidden)') && document.querySelector('#confirmModal').dataset.level === 'danger'`, 8000);
        record('11_danger_locked', await cdp.eval(`document.querySelector('#confirmOk').disabled === true`));
        await cdp.shot('11-danger-locked.png');
        await click(cdp, '#confirmRequiredCheck');
        await waitFor(cdp, `document.querySelector('#confirmOk').disabled === false`, 4000);
        record('12_danger_unlocked', await cdp.eval(`document.querySelector('#confirmOk').disabled === false`));
        await cdp.shot('12-danger-unlocked.png');
        await click(cdp, '#confirmCancel');

        await click(cdp, '#odClose');
        await waitFor(cdp, `document.querySelector('#onlinePanel').classList.contains('hidden')`, 4000);
        await click(cdp, '#rtBlocks [data-name="Stress_StarDelta"]');
        await waitFor(cdp, `document.querySelector('#inspector [data-export-s7dcl]')`, 8000);
        await click(cdp, '[data-export-s7dcl]');
        await waitFor(cdp, `document.querySelector('#outputList').textContent.includes('Stress_StarDelta.s7dcl')`, 10000);
        await cdp.shot('17-g-s7dcl-export.png');
        record('g5_s7dcl_readonly_export', state.gCalls.some(call => call.route === 'export-s7dcl' && call.body.name === 'Stress_StarDelta' && call.body.softwarePath === 'PLC_1'));

        const shots = fs.readdirSync(SHOT_DIR).filter(name => /\.png$/i.test(name)).sort();
        record('screenshot_count_17', shots.length === 17, shots.join(', '));
        record('import_endpoint_called_after_confirm', state.importCount >= 2, 'imports=' + state.importCount);
        record('mock_call_count', state.callCount >= 2, 'calls=' + state.callCount);
        record('console_errors', consoleIssues.length === 0, consoleIssues.join('\n'));
    } finally {
        chrome.kill();
        await new Promise(resolve => chrome.once('exit', resolve));
        for (let i = 0; i < 5; i++) {
            try {
                fs.rmSync(profile, { recursive: true, force: true });
                break;
            } catch (_) {
                await sleep(250);
            }
        }
    }
}

(async () => {
    if (!fs.existsSync(CHROME)) throw new Error('Chrome not found: ' + CHROME);
    const server = http.createServer((req, res) => route(req, res).catch(err => {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(err.stack || err.message);
    }));
    const port = await listen(server);
    try {
        await runBrowser('http://127.0.0.1:' + port);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
    fs.writeFileSync(RESULT_FILE, JSON.stringify({ results, requests: state.requests }, null, 2));
    const failed = Object.entries(results).filter(([, value]) => !value.ok);
    console.log(JSON.stringify({ shotDir: SHOT_DIR, resultFile: RESULT_FILE, failed, results }, null, 2));
    if (failed.length) process.exit(1);
})().catch(err => {
    fs.writeFileSync(RESULT_FILE, JSON.stringify({ error: err.stack || err.message, results }, null, 2));
    console.error(err.stack || err.message);
    process.exit(1);
});
