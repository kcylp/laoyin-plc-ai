const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, isHttpsGitHubUrl, validateManifest } = require('../tools/update-manifest');

const good = {
    product: '老殷工控PLC助手', version: '1.0.2',
    packageUrl: 'https://raw.githubusercontent.com/kcylp/laoyin-plc-ai/main/work/green-build/LaoyinPLC-Green-v1.0.2.zip',
    sha256: 'a'.repeat(64), sizeBytes: 39624748, releaseNotes: '更新器与兼容性改进'
};

test('update manifest accepts the stable HTTPS GitHub package contract', () => {
    assert.equal(compareVersions('1.0.2', '1.0.1'), 1);
    assert.equal(isHttpsGitHubUrl(good.packageUrl), true);
    assert.equal(validateManifest(good).sha256, 'a'.repeat(64));
});

test('update manifest rejects non-GitHub URLs and malformed hashes', () => {
    assert.throws(() => validateManifest({ ...good, packageUrl: 'https://example.com/update.zip' }), /manifest_invalid/);
    assert.throws(() => validateManifest({ ...good, sha256: 'not-a-sha256' }), /manifest_invalid/);
});

test('update manifest rejects package names that could be HTML/error pages', () => {
    assert.throws(() => validateManifest({ ...good, packageUrl: 'https://raw.githubusercontent.com/kcylp/laoyin-plc-ai/main/update-manifest.json' }), /manifest_invalid/);
});
