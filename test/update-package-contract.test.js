const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(repo, relative), 'utf8');

test('green build publishes v1.0.2 with launcher and updater', () => {
    const build = read('work/green-build/build-green.ps1');
    assert.match(build, /\$ver\s*=\s*'v1\.0\.2'/);
    assert.match(build, /LaoyinPLC-Green-/);
    assert.match(build, /System\.Web\.Extensions\.dll/);
    assert.match(build, /updater\.cs/);
    assert.match(build, /老殷工控PLC助手更新器\.exe/);
});

test('launcher validates a ZIP URL and declares the shipped version', () => {
    const launcher = read('work/green-build/launcher.cs');
    assert.match(launcher, /CurrentVersion\s*=\s*"1\.0\.2"/);
    assert.match(launcher, /Path\.GetExtension\(uri\.AbsolutePath\).*"\.zip"/s);
    assert.match(launcher, /ReadManifestBody/);
});

test('updater keeps the backup until the new service is healthy', () => {
    const updater = read('work/green-build/updater.cs');
    const health = updater.indexOf('WaitForHealthyService');
    const deleteBackup = updater.indexOf('TryDelete(backup)');
    assert.notEqual(health, -1);
    assert.notEqual(deleteBackup, -1);
    assert.ok(health < deleteBackup, 'health gate must run before backup deletion');
    assert.match(updater, /更新失败，已恢复原版本/);
});

test('verification targets the new package and updater executable', () => {
    const verify = read('work/green-build/verify-final.ps1');
    assert.match(verify, /LaoyinPLC-Green-v1\.0\.2\.zip/);
    assert.match(verify, /老殷工控PLC助手更新器\.exe/);
});

test('launcher keeps the customer message private and writes bounded sanitized diagnostics', () => {
    const launcher = read('work/green-build/launcher.cs');
    assert.match(launcher, /BuildSafeDiagnostic\s*\(/);
    assert.match(launcher, /SanitizeDiagnostic\s*\(/);
    assert.match(launcher, /Fail\(root,\s*FriendlyFailure\(detail,\s*exitCode\),\s*BuildSafeDiagnostic/s);
    assert.match(launcher, /诊断时间/);
    assert.match(launcher, /启动器版本/);
    assert.match(launcher, /Windows/);
    assert.match(launcher, /后端退出码/);
    assert.match(launcher, /后端文件/);
    assert.match(launcher, /目录写入/);
    assert.match(launcher, /8192/);
    assert.match(launcher, /node:internal/);
    assert.match(launcher, /API[_-]?KEY|ADMIN_KEY|JWT_SECRET/i);
    assert.match(launcher, /Regex/);
    assert.match(launcher, /后端未提供错误详情/);
    assert.match(launcher, /File\.WriteAllText\(Path\.Combine\(root,\s*"启动日志\.txt"\),\s*diagnostic/);
});
