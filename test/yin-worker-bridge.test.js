const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bridge = require('../engineer-yin-bridge');

const ROOT = path.resolve(__dirname, '..');

async function withWorkerEnv(value, fn) {
    const old = process.env.YIN_WORKER;
    if (value === undefined) delete process.env.YIN_WORKER;
    else process.env.YIN_WORKER = value;
    try {
        return await fn();
    } finally {
        if (old === undefined) delete process.env.YIN_WORKER;
        else process.env.YIN_WORKER = old;
    }
}

test('YIN_WORKER=0 forces the legacy one-shot import path', async () => {
    let workerCalls = 0;
    let legacyCalls = 0;
    const result = await withWorkerEnv('0', () => bridge.runYinImportScript('preflight', '<Document />', false, 'xml', {
        workerClient: { request: async () => { workerCalls += 1; throw new Error('worker should be disabled'); } },
        legacyRunner: async (mode, tmpFile, overwrite, kind) => {
            legacyCalls += 1;
            assert.equal(mode, 'preflight');
            assert.equal(overwrite, false);
            assert.equal(kind, 'xml');
            assert.equal(fs.readFileSync(tmpFile, 'utf8'), '<Document />');
            return { ok: true, stage: 'legacy' };
        },
    }));

    assert.equal(workerCalls, 0);
    assert.equal(legacyCalls, 1);
    assert.deepEqual(result, { ok: true, stage: 'legacy' });
});

test('worker failure falls back once to the unchanged legacy path', async () => {
    let legacyCalls = 0;
    const result = await withWorkerEnv(undefined, () => bridge.runYinImportScript('import', 'FUNCTION_BLOCK FB_FAKE\nEND_FUNCTION_BLOCK', true, 'scl', {
        workerClient: { request: async () => { throw new Error('worker down'); } },
        legacyRunner: async (mode, tmpFile, overwrite, kind) => {
            legacyCalls += 1;
            assert.equal(mode, 'import');
            assert.equal(overwrite, true);
            assert.equal(kind, 'scl');
            assert.match(fs.readFileSync(tmpFile, 'utf8'), /FUNCTION_BLOCK FB_FAKE/);
            return { ok: true, stage: 'legacy-after-fallback' };
        },
    }));

    assert.equal(legacyCalls, 1);
    assert.deepEqual(result, { ok: true, stage: 'legacy-after-fallback' });
});

test('worker success bypasses legacy and sends the import file path', async () => {
    let workerCalls = 0;
    let legacyCalls = 0;
    const result = await withWorkerEnv(undefined, () => bridge.runYinImportScript('import', '<Document />', true, 'xml', {
        workerClient: {
            request: async (op, params, timeoutMs) => {
                workerCalls += 1;
                assert.equal(op, 'import');
                assert.equal(params.kind, 'xml');
                assert.equal(params.overwrite, true);
                assert.equal(fs.readFileSync(params.path, 'utf8'), '<Document />');
                assert.equal(timeoutMs, 300000);
                return { ok: true, stage: 'worker' };
            },
        },
        legacyRunner: async () => { legacyCalls += 1; throw new Error('legacy should not run'); },
    }));

    assert.equal(workerCalls, 1);
    assert.equal(legacyCalls, 0);
    assert.deepEqual(result, { ok: true, stage: 'worker' });
});

test('PowerShell worker and legacy script share YinImportCore without duplicated import logic', () => {
    const corePath = path.join(ROOT, 'engine', 'src', 'YinImportCore.ps1');
    const legacyPath = path.join(ROOT, 'engine', 'src', 'yin_import.ps1');
    const workerPath = path.join(ROOT, 'engine', 'src', 'yin_worker.ps1');
    const writeModulePath = path.join(ROOT, 'engine', 'src', 'EngineerYin.Write.psm1');

    assert.ok(fs.existsSync(corePath), 'YinImportCore.ps1 should exist');
    assert.ok(fs.existsSync(workerPath), 'yin_worker.ps1 should exist');

    const core = fs.readFileSync(corePath, 'utf8');
    const legacy = fs.readFileSync(legacyPath, 'utf8');
    const worker = fs.readFileSync(workerPath, 'utf8');
    const writeModule = fs.readFileSync(writeModulePath, 'utf8');

    assert.match(core, /function Invoke-YinImportRequest/);
    assert.match(core, /Import-YinSourceFile/);
    assert.match(core, /UTF8Encoding\(\$true\)/);
    assert.match(core, /Ancestry/);
    assert.match(legacy, /YinImportCore\.ps1/);
    assert.match(worker, /YinImportCore\.ps1/);
    assert.match(worker, /Invoke-YinWorkerImportWithReconnect/);
    assert.match(worker, /function Test-YinWorkerSession/);
    assert.match(worker, /Test-YinWorkerSession/);
    assert.match(writeModule, /function Test-YinPortalConnection/);
    assert.match(writeModule, /Test-YinPortalConnection/);
    assert.doesNotMatch(worker, /function Ensure-YinWorkerSession[\s\S]*?Get-YinBlockInventory[\s\S]*?function Stop-YinWorkerSession/);
    assert.doesNotMatch(worker, /Import-YinSourceFile/);
    assert.doesNotMatch(worker, /Invoke-YinCompile/);
});

test('PowerShell worker reconnect guard does not retry arbitrary import failures', () => {
    const workerPath = path.join(ROOT, 'engine', 'src', 'yin_worker.ps1');
    const worker = fs.readFileSync(workerPath, 'utf8');
    const helperStart = worker.indexOf('function Invoke-YinWorkerImportWithReconnect');
    const helperEnd = worker.indexOf('\ntry {', helperStart);
    assert.ok(helperStart >= 0, 'worker import helper should exist');
    assert.ok(helperEnd > helperStart, 'worker import helper should be isolated before main loop');

    const helper = worker.slice(helperStart, helperEnd);
    assert.match(helper, /Ensure-YinWorkerSession/);
    assert.match(helper, /return Invoke-YinImportRequest/);
    assert.doesNotMatch(helper, /catch\s*\{[\s\S]*Invoke-YinImportRequest/);
});

test('Connect-YinPortal scans all running TIA instances for an open project', () => {
    const writeModulePath = path.join(ROOT, 'engine', 'src', 'EngineerYin.Write.psm1');
    const writeModule = fs.readFileSync(writeModulePath, 'utf8');
    const connectStart = writeModule.indexOf('function Connect-YinPortal');
    const connectEnd = writeModule.indexOf('function Disconnect-YinPortal', connectStart);
    assert.ok(connectStart >= 0, 'Connect-YinPortal should exist');
    assert.ok(connectEnd > connectStart, 'Connect-YinPortal body should be isolated');

    const connectBody = writeModule.slice(connectStart, connectEnd);
    assert.match(connectBody, /foreach\s*\(\$candidate\s+in\s+\$targets\)/);
    assert.match(connectBody, /\$candidatePortal\.Dispose\(\)/);
    assert.match(connectBody, /\$script:Project\s*=\s*\$candidateProject/);
    assert.doesNotMatch(connectBody, /\$procs\s*\|\s*Select-Object\s+-First\s+1/);
});

test('Connect-YinPortal preserves Attach failures and distinguishes security rejection', () => {
    const writeModulePath = path.join(ROOT, 'engine', 'src', 'EngineerYin.Write.psm1');
    const writeModule = fs.readFileSync(writeModulePath, 'utf8');
    const connectStart = writeModule.indexOf('function Connect-YinPortal');
    const connectEnd = writeModule.indexOf('function Disconnect-YinPortal', connectStart);
    const connectBody = writeModule.slice(connectStart, connectEnd);

    assert.match(connectBody, /\$script:LastAttachError\s*=\s*\$null/);
    assert.match(connectBody, /\$script:LastAttachError\s*=\s*\$_\.Exception/);
    assert.match(connectBody, /EngineeringSecurityException|AllowList/);
    assert.match(connectBody, /Siemens TIA Openness/);
    assert.match(connectBody, /原始错误/);
});

test('PowerShell bridge uses an absolute executable, Bypass, and SID-based group checks', () => {
    const bridgeSrc = fs.readFileSync(path.join(ROOT, 'engineer-yin-bridge.js'), 'utf8');
    const resolved = bridge.resolvePowerShellPath({ SystemRoot: 'C:\\Windows' });
    assert.doesNotMatch(bridgeSrc, /const PS1 = ['"]powershell\.exe['"]/);
    assert.equal(path.isAbsolute(resolved), true);
    assert.match(resolved, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
    assert.match(bridgeSrc, /fs\.existsSync\(PS1\)/);
    assert.match(bridgeSrc, /-ExecutionPolicy['"], ['"]Bypass/);
    assert.match(bridgeSrc, /WindowsPrincipal/);
    assert.match(bridgeSrc, /\.IsInRole\(\$sid\)/);
    assert.doesNotMatch(bridgeSrc, /net localgroup \"Siemens TIA Openness\"/);
});

test('one-shot validation scripts stop shared engine clients after S7DCL imports', () => {
    const bridgeSrc = fs.readFileSync(path.join(ROOT, 'engineer-yin-bridge.js'), 'utf8');
    assert.match(bridgeSrc, /function stopSharedEngineClients/);
    assert.match(bridgeSrc, /getSharedClient\(\)\.stop\(\)/);
    assert.match(bridgeSrc, /getSharedYinWorkerClient\(\)\.stop\(\)/);

    for (const file of ['stress-scl-stl.js', 'stress-iec.js', 'stress-s7dcl.js', 'stress-stardelta.js', 'e2e-ai-real.js']) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.match(src, /stopSharedEngineClients/);
        assert.match(src, /\.finally\(\(\) => \{\s*stopSharedEngineClients\(\);\s*\}\)/);
    }
});
