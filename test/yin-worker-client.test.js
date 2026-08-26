const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');

const { YinWorkerClient } = require('../yin-worker-client');

const FAKE_WORKER = path.join(__dirname, 'fixtures', 'fake-yin-worker.js');

function fakeClient(options = {}) {
    return new YinWorkerClient({
        exePath: process.execPath,
        args: [FAKE_WORKER],
        requestTimeoutMs: 5000,
        idleStopMs: 100,
        ...options,
    });
}

test('Yin worker client pings and sends flat NDJSON requests', async () => {
    const client = fakeClient();
    try {
        await client.ensureReady();
        const preflight = await client.request('preflight', { kind: 'scl', path: 'C:/tmp/fake.scl' });
        assert.equal(preflight.ok, true);
        assert.equal(preflight.stage, 'precheck');
        assert.equal(preflight.kind, 'scl');
        assert.equal(preflight.path, 'C:/tmp/fake.scl');

        const status = client.status();
        assert.equal(status.running, true);
        assert.equal(status.ready, true);
        assert.equal(status.project, 'FakeProject');
        assert.equal(status.tiaVersion, 'V21');
    } finally {
        client.stop();
    }
    assert.equal(client.isRunning(), false);
});

test('Yin worker client reports unavailable when executable is missing', () => {
    const client = new YinWorkerClient({ exePath: 'Z:/no/such/powershell.exe' });
    assert.equal(client.available(), false);
    assert.throws(() => client.start(), /不存在/);
});

test('default Yin worker resolves Windows PowerShell to an absolute executable path', () => {
    const client = new YinWorkerClient();
    assert.equal(path.isAbsolute(client.exePath), true);
    assert.match(client.exePath, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
});

test('Yin worker ping failure carries sanitized recent stderr', async () => {
    const client = new YinWorkerClient({ exePath: process.execPath, args: [FAKE_WORKER] });
    client.start = () => {};
    client._request = async () => ({ ok: false, pong: false });
    client.stderrLog = [
        'FATAL at C:\\Users\\alice\\secret\\yin_worker.ps1',
        'Authorization: Bearer sk-live-secret',
        'EngineeringSecurityException: access denied',
    ];

    await assert.rejects(
        () => client.ensureReady(),
        (error) => {
            assert.match(error.message, /Yin worker ping 失败/);
            assert.match(error.message, /EngineeringSecurityException: access denied/);
            assert.doesNotMatch(error.message, /alice|sk-live-secret/);
            assert.deepEqual(error.recentStderr, [
                'FATAL at <path>',
                '<credential-redacted>',
                'EngineeringSecurityException: access denied',
            ]);
            return true;
        },
    );
});

test('Yin worker stays persistent by default for delayed write confirmations', () => {
    const old = process.env.YIN_WORKER_IDLE_MS;
    delete process.env.YIN_WORKER_IDLE_MS;
    try {
        const client = new YinWorkerClient({ exePath: process.execPath, args: [FAKE_WORKER] });
        assert.equal(client.idleStopMs, 0);
    } finally {
        if (old === undefined) delete process.env.YIN_WORKER_IDLE_MS;
        else process.env.YIN_WORKER_IDLE_MS = old;
    }
});

test('Yin worker client returns ok:false protocol responses as engine results', async () => {
    const client = fakeClient();
    try {
        const result = await client.request('fail');
        assert.equal(result.ok, false);
        assert.equal(result.stage, 'error');
        assert.equal(result.message, 'fake failure');
    } finally {
        client.stop();
    }
});

test('Yin worker client rejects pending requests when the worker process dies', async () => {
    const client = fakeClient();
    await client.ensureReady();
    const hang = client.request('hang', {}, 5000);
    client.proc.kill();
    await assert.rejects(hang, /退出|停止|exit/);
});

test('Yin worker timeout kills the old process before a later request restarts safely', async () => {
    const client = fakeClient();
    try {
        await client.ensureReady();
        const oldProc = client.proc;
        await assert.rejects(() => client.request('hang', {}, 30), /超时/);
        await new Promise(resolve => oldProc.once('exit', resolve));
        assert.equal(client.isRunning(), false);

        const result = await client.request('preflight', { kind: 'xml', path: 'C:/tmp/fake.xml' });
        assert.equal(result.ok, true);
        assert.equal(result.kind, 'xml');
        assert.notEqual(client.proc, oldProc);
    } finally {
        client.stop();
    }
});

test('Yin worker timeout rejects every pending request immediately', async () => {
    const client = fakeClient();
    try {
        await client.ensureReady();
        const first = client.request('hang', {}, 30);
        const second = client.request('hang', {}, 5000);

        await assert.rejects(first, /超时/);
        await assert.rejects(second, /超时/);
        assert.equal(client.pending.size, 0);
    } finally {
        client.stop();
    }
});

test('Yin worker child does not keep one-shot scripts alive after a request', async () => {
    const code = `
        const { YinWorkerClient } = require(${JSON.stringify(path.join(__dirname, '..', 'yin-worker-client'))});
        const client = new YinWorkerClient({
            exePath: process.execPath,
            args: [${JSON.stringify(FAKE_WORKER)}],
            requestTimeoutMs: 5000,
            idleStopMs: 100,
        });
        client.request('preflight', { kind: 'xml', path: 'C:/tmp/fake.xml' })
            .then((result) => { if (!result.ok) process.exitCode = 2; })
            .catch((err) => { console.error(err.stack || err.message); process.exitCode = 1; });
    `;

    await new Promise((resolve, reject) => {
        execFile(process.execPath, ['-e', code], { timeout: 1500, windowsHide: true }, (err, stdout, stderr) => {
            if (err) {
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
                return;
            }
            resolve();
        });
    });
});
