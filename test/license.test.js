const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function freshLicense(tempRoot) {
    process.env.LOCALAPPDATA = tempRoot;
    const file = require.resolve('../license');
    delete require.cache[file];
    return require('../license');
}

test('offline trial initializes in the user directory and reports 60 days', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-license-'));
    const license = freshLicense(root);
    const result = license.ensureLicense();
    assert.equal(result.ok, true);
    assert.equal(result.remainingDays, 60);
    assert.equal(license.licensePath().startsWith(root), true);
    assert.equal(fs.existsSync(license.licensePath()), true);
});

test('an unchanged offline trial remains valid', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-license-'));
    const license = freshLicense(root);
    assert.equal(license.ensureLicense().ok, true);
    assert.equal(license.ensureLicense().ok, true);
});

test('a modified license is rejected without exposing an internal path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-license-'));
    const license = freshLicense(root);
    license.ensureLicense();
    const record = JSON.parse(fs.readFileSync(license.licensePath(), 'utf8'));
    record.startedAt = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(license.licensePath(), JSON.stringify(record));
    const result = license.ensureLicense();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID');
    assert.equal(result.message.includes(root), false);
});

test('a deleted license does not reset the trial when the marker remains', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-license-'));
    const license = freshLicense(root);
    license.ensureLicense();
    fs.unlinkSync(license.licensePath());
    const result = license.ensureLicense();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID');
});

test('source-mode server exits 78 on tampered license without leaking paths or stack', () => {
    // H-BUG-1: source-mode (node server.js) must exit 78 on a tampered license
    // without printing stack traces or absolute internal paths to stderr.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-license-'));
    const license = freshLicense(root);
    license.ensureLicense();
    const record = JSON.parse(fs.readFileSync(license.licensePath(), 'utf8'));
    record.startedAt = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(license.licensePath(), JSON.stringify(record));

    const serverPath = path.join(__dirname, '..', 'server.js');
    const node = process.execPath;
    const r = spawnSync(node, [serverPath], {
        cwd: path.dirname(serverPath),
        env: { ...process.env, LOCALAPPDATA: root, PORT: '0' },
        timeout: 15000,
        encoding: 'utf8',
    });
    assert.equal(r.status, 78);
    const stderr = r.stderr || '';
    assert.equal(stderr.includes('at '), false, 'stderr must not contain stack trace "at " lines');
    assert.equal(stderr.includes(root), false, 'stderr must not contain the temp license root path');
    assert.equal(stderr.includes('LICENSE_REQUIRED'), false, 'stderr must not leak the internal error id');
    assert.equal(stderr.includes('Error'), false, 'stderr must not contain a Node error header');
});

test('source-mode server fails closed with exit 79 when security secrets are missing outside test harness', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-auth-'));
    const license = freshLicense(root);
    license.ensureLicense();

    const serverPath = path.join(__dirname, '..', 'server.js');
    const env = { ...process.env, LOCALAPPDATA: root, PORT: '0', JWT_SECRET: '', ADMIN_KEY: '' };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    delete env.DB_PATH;

    const r = spawnSync(process.execPath, [serverPath], {
        cwd: path.dirname(serverPath),
        env,
        timeout: 15000,
        encoding: 'utf8',
    });

    assert.equal(r.status, 79);
    const stderr = r.stderr || '';
    assert.match(stderr, /启动失败：安全密钥未配置或强度不足。绿色版请通过启动器启动/);
    assert.equal(stderr.includes(root), false, 'stderr must not contain the temp user root path');
    assert.equal(stderr.includes(' at '), false, 'stderr must not contain stack trace frames');
    assert.equal(stderr.includes('node:internal'), false, 'stderr must not contain Node internals');
});
