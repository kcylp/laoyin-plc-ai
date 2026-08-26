const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    TiaMcpClient,
    detectPortalRoot,
    discoverTiaEnvironment,
    findTiaPortalRoots,
    getSupportedTiaMajorVersions,
} = require('../tia-mcp-client');

const FAKE_SERVER = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');

function fakeClient() {
    return new TiaMcpClient({ exePath: process.execPath, args: [FAKE_SERVER], requestTimeoutMs: 5000 });
}

test('MCP client initializes, lists tools, and calls a tool (fake stdio server)', async () => {
    const client = fakeClient();
    try {
        const tools = await client.listTools();
        assert.deepEqual(tools.map(t => t.name), ['FakeTool', 'FailTool', 'HangTool']);

        const result = await client.callTool('FakeTool', { a: 1 });
        assert.deepEqual(TiaMcpClient.jsonOf(result), { echo: { a: 1 } });

        await assert.rejects(() => client.callTool('FailTool'), /boom/);

        const status = client.status();
        assert.equal(status.running, true);
        assert.equal(status.initialized, true);
        assert.equal(status.serverInfo.name, 'fake-tia');
    } finally {
        client.stop();
    }
    assert.equal(client.isRunning(), false);
});

test('MCP client reports unavailable when exe is missing', () => {
    const client = new TiaMcpClient({ exePath: 'Z:/no/such/exe.exe' });
    assert.equal(client.available(), false);
    assert.throws(() => client.start(), /不存在/);
});

test('MCP client rejects pending calls when the server process dies', async () => {
    const client = fakeClient();
    await client.ensureReady();
    const hang = client.callTool('FakeTool', {}); // 先杀掉再观察拒绝
    client.proc.kill();
    await assert.rejects(hang, /退出|停止/);
});

test('MCP timeout terminates the old process before a later call restarts safely', async () => {
    const client = fakeClient();
    try {
        await client.ensureReady();
        const oldProc = client.proc;
        await assert.rejects(() => client.callTool('HangTool', {}, 30), /超时/);
        await new Promise(resolve => oldProc.once('exit', resolve));
        assert.equal(client.isRunning(), false);
        const result = await client.callTool('FakeTool', { recovered: true });
        assert.deepEqual(TiaMcpClient.jsonOf(result), { echo: { recovered: true } });
        assert.notEqual(client.proc, oldProc);
    } finally {
        client.stop();
    }
});

test('TIA portal root discovery honors environment and EditionMain fallback without requiring TIA_Opns', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-tia-root-'));
    const portalRoot = path.join(tempRoot, 'Portal V21');
    fs.mkdirSync(portalRoot, { recursive: true });
    const calls = [];
    const fakeExec = (_file, args) => {
        calls.push(args.join(' '));
        const key = args[1] || '';
        if (key.endsWith('\\EditionMain')) return `Path    REG_SZ    ${portalRoot}\\\r\n`;
        throw new Error('missing registry value');
    };
    try {
        const roots = require('../tia-mcp-client').findTiaPortalRoots(21, {
            env: {},
            execFileSync: fakeExec,
            fsApi: fs,
        });
        assert.equal(roots[0].path, portalRoot);
        assert.equal(roots[0].source, 'registry:EditionMain');
        assert.ok(calls.some(call => call.includes('EditionMain')));
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('TIA portal root discovery prefers explicit customer environment path', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-tia-env-'));
    const portalRoot = path.join(tempRoot, 'Portal V21');
    fs.mkdirSync(portalRoot, { recursive: true });
    try {
        const roots = require('../tia-mcp-client').findTiaPortalRoots(21, {
            env: { YIN_TIA_PORTAL_ROOT: portalRoot },
            execFileSync: () => { throw new Error('registry should not be needed'); },
            fsApi: fs,
        });
        assert.equal(roots[0].path, portalRoot);
        assert.equal(roots[0].source, 'YIN_TIA_PORTAL_ROOT');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('TIA portal root discovery returns null instead of a fabricated default path', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-tia-empty-'));
    try {
        const options = {
            env: { ProgramFiles: tempRoot, ProgramW6432: tempRoot },
            execFileSync: () => { throw new Error('registry empty'); },
            fsApi: fs,
        };
        assert.deepEqual(findTiaPortalRoots(21, options), []);
        assert.equal(detectPortalRoot(21, options), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('supported TIA versions are discovered from runtime directories', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-tia-runtime-'));
    try {
        const runtimeDir = path.join(tempRoot, 'runtime');
        fs.mkdirSync(path.join(runtimeDir, 'v19'), { recursive: true });
        fs.mkdirSync(path.join(runtimeDir, 'v21'), { recursive: true });
        fs.mkdirSync(path.join(runtimeDir, 'notes'), { recursive: true });
        assert.deepEqual(getSupportedTiaMajorVersions({ runtimeDir }), [19, 21]);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('MCP client blocks a clearly unsupported installed TIA version before spawning exe', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-tia-gate-'));
    try {
        const runtimeDir = path.join(tempRoot, 'runtime');
        const automationRoot = path.join(tempRoot, 'Siemens', 'Automation');
        const portalV19 = path.join(automationRoot, 'Portal V19');
        fs.mkdirSync(path.join(runtimeDir, 'v21'), { recursive: true });
        fs.mkdirSync(portalV19, { recursive: true });

        const client = new TiaMcpClient({
            exePath: process.execPath,
            runtimeDir,
            discoveryOptions: {
                env: { ProgramFiles: tempRoot, ProgramW6432: tempRoot },
                execFileSync: () => { throw new Error('registry empty'); },
                fsApi: fs,
            },
        });

        assert.throws(() => client.start(), /检测到您安装的是博途 V19[\s\S]*仅支持博途 V21[\s\S]*已阻止/);
        assert.equal(client.isRunning(), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('MCP client reports version mismatch before missing sibling runtime exe', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-tia-gate-default-'));
    try {
        const runtimeDir = path.join(tempRoot, 'runtime');
        const portalV19 = path.join(tempRoot, 'Siemens', 'Automation', 'Portal V19');
        fs.mkdirSync(path.join(runtimeDir, 'v21'), { recursive: true });
        fs.mkdirSync(portalV19, { recursive: true });

        const client = new TiaMcpClient({
            runtimeDir,
            discoveryOptions: {
                env: { ProgramFiles: tempRoot, ProgramW6432: tempRoot },
                execFileSync: () => { throw new Error('registry empty'); },
                fsApi: fs,
            },
        });

        assert.equal(client.available(), false);
        assert.throws(() => client.start(), /检测到您安装的是博途 V19[\s\S]*仅支持博途 V21[\s\S]*已阻止/);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Openness assembly registry path resolves a non-default TIA installation', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-tia-registry-'));
    try {
        const portalRoot = path.join(tempRoot, 'D-drive', 'Siemens', 'Automation', 'Portal V21');
        const publicApiDir = path.join(portalRoot, 'PublicAPI', 'V21', 'net48');
        const assemblyPath = path.join(publicApiDir, 'Siemens.Engineering.Base.dll');
        fs.mkdirSync(publicApiDir, { recursive: true });
        fs.writeFileSync(assemblyPath, 'fixture');
        const fakeExec = (_file, args) => {
            const key = args[1] || '';
            const valueName = args[3] || '';
            if (key.includes('Openness\\21.0') && valueName === 'Siemens.Engineering.Base') {
                return `Siemens.Engineering.Base    REG_SZ    ${assemblyPath}\r\n`;
            }
            throw new Error('missing registry value');
        };

        const roots = findTiaPortalRoots(21, {
            env: {},
            execFileSync: fakeExec,
            fsApi: fs,
        });
        assert.equal(roots[0].path, portalRoot);
        assert.equal(roots[0].source, 'registry:Openness/PublicAPI');
        assert.equal(roots[0].publicApiDir, publicApiDir);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('multiple installed versions select the highest supported version and explain override', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-tia-multi-'));
    try {
        const runtimeDir = path.join(tempRoot, 'runtime');
        const automationRoot = path.join(tempRoot, 'Siemens', 'Automation');
        fs.mkdirSync(path.join(runtimeDir, 'v21'), { recursive: true });
        fs.mkdirSync(path.join(automationRoot, 'Portal V20'), { recursive: true });
        fs.mkdirSync(path.join(automationRoot, 'Portal V21'), { recursive: true });

        const result = discoverTiaEnvironment({
            runtimeDir,
            env: { ProgramFiles: tempRoot, ProgramW6432: tempRoot },
            execFileSync: () => { throw new Error('registry empty'); },
            fsApi: fs,
        });
        assert.deepEqual(result.installedVersions.map(item => item.major), [20, 21]);
        assert.equal(result.selectedMajor, 21);
        assert.deepEqual(result.supportedByThisBuild, [21]);
        assert.equal(result.mismatch, false);
        assert.match(result.notice, /同时检测到博途 V20、V21[\s\S]*将使用 V21[\s\S]*YIN_TIA_PORTAL_ROOT/);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('explicit TIA portal root wins over automatic multi-version selection', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-tia-explicit-'));
    try {
        const runtimeDir = path.join(tempRoot, 'runtime');
        const automationRoot = path.join(tempRoot, 'Siemens', 'Automation');
        const explicitV19 = path.join(automationRoot, 'Portal V19');
        fs.mkdirSync(path.join(runtimeDir, 'v21'), { recursive: true });
        fs.mkdirSync(explicitV19, { recursive: true });
        fs.mkdirSync(path.join(automationRoot, 'Portal V21'), { recursive: true });

        const result = discoverTiaEnvironment({
            runtimeDir,
            env: {
                ProgramFiles: tempRoot,
                ProgramW6432: tempRoot,
                YIN_TIA_PORTAL_ROOT: explicitV19,
            },
            execFileSync: () => { throw new Error('registry empty'); },
            fsApi: fs,
        });
        assert.equal(result.selectedMajor, 19);
        assert.deepEqual(result.mismatch, { detected: 19, supported: [21] });
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('requested TIA major wins over automatic multi-version selection', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-tia-requested-'));
    try {
        const runtimeDir = path.join(tempRoot, 'runtime');
        const automationRoot = path.join(tempRoot, 'Siemens', 'Automation');
        fs.mkdirSync(path.join(runtimeDir, 'v21'), { recursive: true });
        fs.mkdirSync(path.join(automationRoot, 'Portal V20'), { recursive: true });
        fs.mkdirSync(path.join(automationRoot, 'Portal V21'), { recursive: true });

        const client = new TiaMcpClient({
            tiaMajorVersion: 20,
            runtimeDir,
            discoveryOptions: {
                env: { ProgramFiles: tempRoot, ProgramW6432: tempRoot },
                execFileSync: () => { throw new Error('registry empty'); },
                fsApi: fs,
            },
        });

        assert.equal(client.status().tiaMajorVersion, 20);
        assert.equal(client.status().portalRoot, path.join(automationRoot, 'Portal V20'));
        assert.deepEqual(client.status().discovery.mismatch, { detected: 20, supported: [21] });
        assert.throws(() => client.start(), /检测到您安装的是博途 V20[\s\S]*仅支持博途 V21[\s\S]*已阻止/);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('MCP client reports a Chinese diagnosis hint when TIA is not installed', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-tia-none-'));
    try {
        const runtimeDir = path.join(tempRoot, 'runtime');
        fs.mkdirSync(path.join(runtimeDir, 'v21'), { recursive: true });
        const client = new TiaMcpClient({
            exePath: process.execPath,
            runtimeDir,
            discoveryOptions: {
                env: { ProgramFiles: tempRoot, ProgramW6432: tempRoot },
                execFileSync: () => { throw new Error('registry empty'); },
                fsApi: fs,
            },
        });
        assert.throws(() => client.start(), /未检测到博途安装[\s\S]*Openness[\s\S]*一键环境诊断/);
        assert.equal(client.isRunning(), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('TIA version UI and PowerShell diagnostics expose dynamic discovery without persistence', () => {
    const fs = require('node:fs');
    const settings = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
    const discovery = fs.readFileSync(path.join(__dirname, '..', 'engine', 'src', 'YinTiaDiscovery.ps1'), 'utf8');
    const diagnosis = fs.readFileSync(path.join(__dirname, '..', 'tools', 'diagnose-tia.ps1'), 'utf8');
    const writer = fs.readFileSync(path.join(__dirname, '..', 'engine', 'src', 'EngineerYin.Write.psm1'), 'utf8');

    assert.match(settings, /id="tiaPortalRoot"[^>]*placeholder="[^\"]*留空自动检测/);
    assert.match(settings, /博途安装路径/);
    assert.match(discovery, /Siemens\.Engineering(?:\.Base)?/);
    assert.match(discovery, /PathSource/);
    assert.match(diagnosis, /supportedByThisBuild/);
    assert.doesNotMatch(diagnosis, /runtime\\v21/);
    assert.doesNotMatch(diagnosis, /Portal V21/);
    assert.doesNotMatch(writer, /Open TIA Portal V21/);
});
