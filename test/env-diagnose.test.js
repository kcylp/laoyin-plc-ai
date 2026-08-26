const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const express = require('express');

const { sanitizeDiagnostic } = require('../lib/sanitize');
const createAdminRoutes = require('../routes/admin');
const execFileAsync = promisify(execFile);

function findItem(result, id) {
    return result.items.find(item => item.id === id);
}

async function requestJson(router, method, route, body, headers = {}) {
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const address = server.address();
        const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
            method,
            headers: { 'content-type': 'application/json', ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, json: await response.json() };
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

function passAuth(req, res, next) {
    req.user = { id: 1, username: 'tester' };
    next();
}

function rejectAuth(req, res) {
    res.status(401).json({ success: false, message: 'no token' });
}

function rejectLocal(req, res) {
    res.status(403).json({ success: false, message: 'not local' });
}

function fakeDb(modelCount = 1) {
    return {
        prepare(sql) {
            return {
                get() {
                    if (/ai_models/i.test(sql)) return { c: modelCount };
                    if (/ai_providers/i.test(sql)) return { c: 2 };
                    return { c: 0 };
                },
            };
        },
    };
}

function samplePowerShellResult(overrides = {}) {
    return {
        dotNetFramework: { Release: 528040, Meets48: true },
        executionPolicy: { Effective: 'RemoteSigned' },
        tiaInstalls: [{ EngineeringVersion: 'V21', EngineeringBaseExists: true, Step7Exists: true, WinCCUnifiedExists: false }],
        opennessGroup: { Checked: true, InGroup: false },
        port3000: { InUse: false, Pids: [] },
        tiaProcess: { Running: false, ProcessCount: 0, ProjectState: 'not-running' },
        mcp: { ExeExists: true, DoctorAttempted: true, DoctorOk: false, DoctorMessage: 'JWT_SECRET=abc sk-live C:\\Users\\alice\\x' },
        motw: { BlockedCount: 0 },
        defender: { Status: 'unknown', Message: 'access denied' },
        logPathWritable: { Checked: true, Writable: true },
        issues: ['当前 Windows 用户不在 Siemens TIA Openness 组'],
        ...overrides,
    };
}

test('sanitizeDiagnostic redacts credentials, emails, paths and stack frames', () => {
    const raw = [
        'Authorization: Bearer sk-live-abcdef1234567890',
        'standalone key sk-direct-abcdef1234567890',
        'ADMIN_KEY=secret-admin JWT_SECRET: jwt-secret SMTP_PASS=mail-pass IMAP_PASS=imap-pass TOKEN=token123',
        'operator alice@qq.com opened F:\\工控软件\\secret\\file.log and \\\\nas\\share\\trace.txt',
        '    at Object.<anonymous> (C:\\Users\\alice\\app.js:1:2)',
        'normal diagnostic line',
    ];

    const clean = sanitizeDiagnostic(raw).join('\n');
    assert.doesNotMatch(clean, /sk-live|secret-admin|jwt-secret|mail-pass|imap-pass|token123/i);
    assert.doesNotMatch(clean, /alice@qq\.com|F:\\|C:\\Users|\\\\nas/i);
    assert.doesNotMatch(clean, /Object\.<anonymous>|app\.js:1:2/);
    assert.match(clean, /<credential-redacted>/);
    assert.match(clean, /<api-key-redacted>/);
    assert.match(clean, /normal diagnostic line/);
});

test('runDiagnose builds real quick items from the PowerShell diagnostic script and backend state', async () => {
    const { runDiagnose } = require('../lib/env-diagnose');
    let capturedArgs = null;
    const result = await runDiagnose({
        deep: false,
        deps: {
            db: fakeDb(1),
            env: { SMTP_PASS: 'configured' },
            processVersion: 'v22.5.0',
            runPowerShell: async (args) => {
                capturedArgs = args;
                return samplePowerShellResult({ dotNetFramework: { Release: 460805, Meets48: false } });
            },
            now: () => 10,
        },
    });

    assert.equal(result.success, true);
    assert.equal(result.deep, false);
    assert.ok(capturedArgs.includes('-ExecutionPolicy'));
    assert.ok(capturedArgs.includes('Bypass'));
    assert.ok(capturedArgs.includes('-SkipMcpDoctor'));
    assert.equal(findItem(result, 'node').实测值, 'v22.5.0');
    assert.equal(findItem(result, 'dotnet48').状态, 'fail');
    assert.match(findItem(result, 'dotnet48').修复建议, /\.NET Framework 4\.8/);
    assert.equal(findItem(result, 'openness-group').状态, 'warn');
    assert.equal(findItem(result, 'ai-provider').状态, 'ok');
    assert.equal(findItem(result, 'mail').状态, 'ok');
    assert.match(result.summary, /失败|警告/);
});

test('deep diagnosis is queued by the admin route and env-check is auth plus localOnly protected', async () => {
    const calls = [];
    const router = createAdminRoutes({
        db: fakeDb(1),
        authenticateToken: passAuth,
        localOnly: passAuth,
        enqueueTiaOp: async (fn) => {
            calls.push('queued');
            return fn();
        },
        envDiagnoseDeps: {
            env: {},
            runPowerShell: async (args) => samplePowerShellResult({ mcp: { ExeExists: true, DoctorAttempted: args.includes('-SkipMcpDoctor') === false, DoctorOk: true, DoctorMessage: 'ok' } }),
            now: () => 20,
        },
        checkAdmin: () => false,
        getUserById: () => null,
        getUserByUsername: () => null,
        sendMail: async () => {},
        htmlEscape: value => String(value),
    });

    const ok = await requestJson(router, 'GET', '/api/env-check?deep=1');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.success, true);
    assert.equal(calls.length, 1);
    assert.equal(findItem(ok.json, 'mcp-doctor').状态, 'ok');

    const unauth = await requestJson(createAdminRoutes({ authenticateToken: rejectAuth, localOnly: passAuth }), 'GET', '/api/env-check');
    assert.equal(unauth.status, 401);

    const nonLocal = await requestJson(createAdminRoutes({ authenticateToken: passAuth, localOnly: rejectLocal }), 'GET', '/api/env-check');
    assert.equal(nonLocal.status, 403);
});

test('diagnostic export creates a sanitized package and never copies sensitive files', async () => {
    const { exportDiagnosticPackage } = require('../lib/env-diagnose');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-diagnose-root-'));
    const desktop = fs.mkdtempSync(path.join(os.tmpdir(), 'env-diagnose-desktop-'));
    const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'env-diagnose-local-'));
    fs.mkdirSync(path.join(root, 'work', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'work', 'logs', 'tia-ops.jsonl'), Array.from({ length: 502 }, (_, i) => `{"n":${i},"token":"sk-live-${i}","path":"F:\\\\secret\\\\${i}"}`).join('\n'));
    fs.mkdirSync(path.join(root, 'engine', 'tia-mcp', 'runtime', 'v21'), { recursive: true });
    fs.writeFileSync(path.join(root, 'engine', 'tia-mcp', 'runtime', 'v21', 'TiaMcpServer.startup.log'), 'Bearer sk-live-startup\nC:\\Users\\alice\\runtime');
    fs.writeFileSync(path.join(root, '.env'), 'API_KEY=sk-live-env');
    fs.writeFileSync(path.join(root, 'plc_assistant.db'), 'secret db');
    fs.writeFileSync(path.join(root, 'license.json'), 'secret license');
    const launchDir = path.join(localAppData, '老殷工控PLC助手');
    fs.mkdirSync(launchDir, { recursive: true });
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(launchDir, `启动日志-20260823-100${i}.txt`), `JWT_SECRET=jwt-${i}\nalice@qq.com\nF:\\logs\\${i}`);

    const exported = await exportDiagnosticPackage({
        deep: true,
        deps: {
            appRoot: root,
            desktopDir: desktop,
            localAppData,
            openFolder: false,
            db: fakeDb(0),
            env: {},
            processVersion: 'v22.5.0',
            runPowerShell: async () => samplePowerShellResult(),
            now: () => Date.parse('2026-08-23T10:00:00Z'),
        },
    });

    assert.equal(exported.success, true);
    assert.ok(fs.existsSync(path.join(exported.packagePath, '诊断报告.txt')));
    assert.ok(fs.existsSync(path.join(exported.packagePath, '诊断结果.json')));
    assert.ok(fs.existsSync(path.join(exported.packagePath, '启动日志')));
    const files = fs.readdirSync(exported.packagePath, { recursive: true }).map(String);
    assert.equal(files.some(name => /\.env|license\.json|plc_assistant\.db|secrets\.json/i.test(name)), false);
    const allText = files
        .map(name => path.join(exported.packagePath, name))
        .filter(file => fs.statSync(file).isFile())
        .map(file => fs.readFileSync(file, 'utf8'))
        .join('\n');
    assert.doesNotMatch(allText, /sk-|Bearer|JWT_SECRET=.*jwt|alice@qq\.com|F:\\|C:\\Users/i);
    assert.match(allText, /本诊断包已自动脱敏/);
    assert.equal(fs.readdirSync(path.join(exported.packagePath, '启动日志')).length, 5);
});

test('Openness group auto-fix is authenticated, local-only and queued', async () => {
    const calls = [];
    const router = createAdminRoutes({
        authenticateToken: passAuth,
        localOnly: passAuth,
        enqueueTiaOp: async fn => {
            calls.push('queued');
            return fn();
        },
        getMcpClient: () => ({
            ensureReady: async () => calls.push('ready'),
            callTool: async (name, args) => {
                calls.push([name, args]);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, added: true }) }] };
            },
        }),
    });

    const fixed = await requestJson(router, 'POST', '/api/env-check/fix', { id: 'openness-group' });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.json.result.success, true);
    assert.deepEqual(calls, ['queued', 'ready', ['EnsureOpennessUserGroup', {}]]);

    const invalid = await requestJson(router, 'POST', '/api/env-check/fix', { id: 'node' });
    assert.equal(invalid.status, 400);

    const unauth = await requestJson(createAdminRoutes({ authenticateToken: rejectAuth, localOnly: passAuth }), 'POST', '/api/env-check/fix', { id: 'openness-group' });
    assert.equal(unauth.status, 401);
});

test('env-check page uses backend data and exposes refresh, deep diagnosis and export controls', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'env-check.html'), 'utf8');
    assert.doesNotMatch(html, /navigator\.userAgent\.match\(\/Node\\\.js/);
    assert.match(html, /重新检查/);
    assert.match(html, /深度诊断/);
    assert.match(html, /导出诊断包/);
    assert.match(html, /\/api\/env-check\?deep=/);
    assert.match(html, /\/api\/diagnose\/export/);
    assert.match(html, /立即修复/);
    assert.match(html, /\/api\/env-check\/fix/);
});

test('PowerShell diagnosis keeps quick probes lightweight and bounds MCP doctor runtime', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'diagnose-tia.ps1'), 'utf8');
    assert.match(script, /Get-Port3000\(\[bool\]\$detailed\)/);
    assert.match(script, /GetActiveTcpListeners\(\)/);
    assert.match(script, /if \(\$SkipMcpDoctor\) \{[\s\S]*\[System\.Environment\]::OSVersion/);
    assert.match(script, /\.WaitForExit\(15000\)/);
    assert.match(script, /DoctorMessage = 'MCP doctor 超过 15 秒，已终止'/);
});

test('PowerShell JSON index remains readable through Node when AppRoot contains Chinese', {
    skip: process.platform !== 'win32',
}, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-diagnose-encoding-'));
    const appRoot = path.join(root, '中文诊断根');
    fs.mkdirSync(appRoot, { recursive: true });
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = path.join(__dirname, '..', 'tools', 'diagnose-tia.ps1');

    const { stdout } = await execFileAsync(powershell, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-AppRoot', appRoot, '-SkipMcpDoctor',
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const index = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));

    assert.equal(fs.existsSync(index.json), true, `Node 解码后的诊断路径不存在: ${index.json}`);
    const diagnostic = JSON.parse(fs.readFileSync(index.json, 'utf8'));
    assert.equal(diagnostic.format, 'laoyin-tia-diagnostic-v1');
    assert.equal(typeof diagnostic.mcp.DoctorAttempted, 'boolean');
});
