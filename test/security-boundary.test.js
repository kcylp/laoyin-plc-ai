const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');

const createAuthRoutes = require('../routes/auth');
const createTiaMcpRoutes = require('../routes/tia-mcp');
const manifest = require('../engine/tia-mcp/manifest/tools-list.json');
const helpers = require('../lib/tia-mcp-helpers');

const root = path.resolve(__dirname, '..');

function freePort() {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

async function waitReady(base, getLog, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const response = await fetch(base + '/login.html');
            if (response.ok) return;
        } catch {
            // The child has not opened its listener yet.
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('被测服务未就绪：' + getLog());
}

async function startSourceServer(t) {
    const port = await freePort();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task006-server-'));
    const dbPath = path.join(temp, 'test.db');
    const child = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: {
            ...process.env,
            PORT: String(port),
            DB_PATH: dbPath,
            LOCALAPPDATA: temp,
            TIA_PREWARM: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.on('data', chunk => { log += chunk; });
    t.after(async () => {
        await new Promise(resolve => {
            const timer = setTimeout(resolve, 1000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
            child.kill('SIGKILL');
        });
        try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Windows handle race */ }
    });
    const base = `http://127.0.0.1:${port}`;
    await waitReady(base, () => log);
    return { base, child, getLog: () => log };
}

async function requestJson(base, method, url, body, token) {
    const response = await fetch(base + url, {
        method,
        headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: 'Bearer ' + token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
}

function passAuth(req, res, next) {
    req.user = { id: 1, username: 'tester' };
    next();
}

async function serveRouter(router, mount, fn) {
    const app = express();
    app.use(express.json({ limit: '3mb' }));
    app.use(mount, router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        return await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

test('source server exposes only approved frontend assets and hides sensitive project files as 404', async (t) => {
    const { base } = await startSourceServer(t);
    for (const url of [
        '/lib/auth.js',
        '/routes/admin.js',
        '/license.js',
        '/crypto-util.js',
        '/work/logs/tia-ops.jsonl',
        '/engine/src/EngineerYin.Write.psm1',
        '/engine/tia-mcp/manifest/tools-list.json',
    ]) {
        const response = await fetch(base + url);
        assert.equal(response.status, 404, `${url} must not disclose whether the file exists`);
    }
    const frontendUrls = [
        '/', '/login.html', '/index.html', '/settings.html', '/admin.html', '/env-check.html', '/upgrade.html',
        '/login.css', '/login.js', '/admin.css', '/admin.js', '/operations.css', '/upgrade.css', '/upgrade.js',
        '/ai-models.js', '/plc-language.js', '/tia-confirmation.js', '/tia-import-state.js',
        ...fs.readdirSync(path.join(root, 'web'), { recursive: true })
            .filter(file => /\.(?:css|js)$/i.test(file))
            .map(file => '/web/' + String(file).replace(/\\/g, '/')),
    ];
    for (const url of frontendUrls) {
        const response = await fetch(base + url);
        assert.equal(response.status, 200, `${url} must remain available`);
        assert.match(response.headers.get('cache-control') || '', /no-store/);
    }
    const favicon = await fetch(base + '/favicon.ico');
    assert.equal(favicon.status, 204, 'automatic favicon request must not create a browser-network 404');
});

test('source server accepts a 200KB LAD payload and returns a business response instead of body-parser 500', async (t) => {
    const { base } = await startSourceServer(t);
    const username = 'task006_' + Date.now();
    const registration = await requestJson(base, 'POST', '/api/register', { username, password: 'test123456' });
    assert.equal(registration.status, 200);
    const login = await requestJson(base, 'POST', '/api/login', { username, password: 'test123456' });
    assert.ok(login.json.token);
    const xml = '<Document><SW.Blocks.FC ID="0">' + ' '.repeat(210000) + '</SW.Blocks.FC></Document>';
    const result = await requestJson(base, 'POST', '/api/tia/import', { xml, lang: 'lad' }, login.json.token);
    assert.notEqual(result.status, 500);
    assert.notEqual(result.json?.message, '服务器内部错误');
});

test('all 200 manifest tools are classified fail-closed and approved high-risk groups require confirmation', () => {
    assert.equal(manifest.toolCount, 200);
    assert.equal(manifest.tools.length, 200);
    assert.equal(typeof helpers.requiresTiaMcpConfirmation, 'function');
    for (const tool of manifest.tools) {
        assert.equal(typeof helpers.requiresTiaMcpConfirmation(tool.name), 'boolean', tool.name);
    }
    for (const name of [
        'SetWatchTableModifyValue', 'SaveProject', 'SaveAsProject', 'ImportBlock',
        'CompileSoftware', 'CompileAndDiagnosePlc', 'ExportBlock', 'ExportHmiScreen',
    ]) {
        assert.equal(helpers.requiresTiaMcpConfirmation(name), true, name);
    }
    for (const name of ['GetProject', 'ListObjectChildren', 'ReadPlcLiveValuesS7', 'CheckDownloadReadiness']) {
        assert.equal(helpers.requiresTiaMcpConfirmation(name), false, name);
    }
    assert.equal(helpers.requiresTiaMcpConfirmation('FutureUnknownTool'), true);
});

test('MCP tools advertise requiresConfirm and unconfirmed write calls are blocked without execution', async () => {
    const calls = [];
    const client = {
        listTools: async () => manifest.tools.slice(0, 5),
        callTool: async (name, args) => {
            calls.push([name, args]);
            return { content: [{ type: 'text', text: '{}' }] };
        },
        status: () => ({}),
    };
    const deps = {
        authenticateToken: passAuth,
        localOnly: passAuth,
        enqueueTiaOp: fn => fn(),
        getUserById: () => ({ id: 1, username: 'tester' }),
        getCurrentModel: () => null,
        listUserModels: () => [],
        llmStream: async () => {},
        mcpEnsureAttached: async () => ({ ok: true, project: 'P' }),
        parseBlocksFromTree: () => [],
        requiresTiaMcpConfirmation: helpers.requiresTiaMcpConfirmation,
        getPrewarmStatus: () => 'off',
        getMcpClient: () => client,
    };
    const router = createTiaMcpRoutes(deps);
    await serveRouter(router, '/api/tia/mcp', async base => {
        const tools = await requestJson(base, 'GET', '/api/tia/mcp/tools');
        assert.equal(tools.status, 200);
        assert.equal(tools.json.tools.every(tool => typeof tool.requiresConfirm === 'boolean'), true);
        for (const name of ['SetWatchTableModifyValue', 'SaveProject', 'ImportBlock']) {
            const blocked = await requestJson(base, 'POST', '/api/tia/mcp/call', { name, args: {} });
            assert.equal(blocked.status, 400, name);
            assert.equal(blocked.json.dangerous, true, name);
            assert.equal(blocked.json.requiresConfirm, true, name);
        }
        assert.equal(calls.length, 0);
    });
});

test('SMTP rejection returns a readable registration error and the auth router keeps serving requests', async () => {
    const users = new Map();
    let nextId = 1;
    const db = {
        prepare(sql) {
            return {
                run(...args) {
                    if (/INSERT INTO users/i.test(sql)) {
                        const id = nextId++;
                        users.set(args[0], { id, username: args[0], password: args[1], email: args[2], status: args[5] });
                        return { lastInsertRowid: id };
                    }
                    return { changes: 0 };
                },
            };
        },
    };
    const router = createAuthRoutes({
        db,
        authenticateToken: passAuth,
        getUserByUsername: username => users.get(username),
        getUserById: () => null,
        sendMail: async () => { throw new Error('connect ECONNREFUSED smtp.local:465'); },
        htmlEscape: value => String(value),
        registrationApprovalRequired: true,
        SITE_URL: 'http://127.0.0.1:3000',
        ADMIN_KEY: 'a'.repeat(32),
        ADMIN_EMAIL: 'admin@example.invalid',
        JWT_SECRET: 'j'.repeat(32),
    });
    await serveRouter(router, '/api', async base => {
        const failed = await requestJson(base, 'POST', '/api/register', {
            username: 'smtp_user', password: 'test123456', email: 'user@example.invalid',
        });
        assert.equal(failed.status, 503);
        assert.match(failed.json.message, /邮件|稍后重试/);
        assert.doesNotMatch(failed.json.message, /ECONNREFUSED|smtp\.local|465/i);

        const alive = await requestJson(base, 'POST', '/api/register', {});
        assert.equal(alive.status, 400);
        assert.match(alive.json.message, /不能为空/);
    });
});

test('online panel consumes backend confirmation metadata and retries a dangerous response after confirmation', () => {
    const source = fs.readFileSync(path.join(root, 'web', 'online.js'), 'utf8');
    assert.doesNotMatch(source, /DANGEROUS_TOOL_RE/);
    assert.match(source, /requiresConfirm/);
    assert.match(source, /j\.dangerous/);
    assert.match(source, /confirmed:\s*true/);
    assert.match(source, /confirmDialog/);
});
