
'use strict';

const crypto = require('node:crypto');

const UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/kcylp/laoyin-plc-ai/main/update-manifest.json';
const PACKAGE_URL = 'https://raw.githubusercontent.com/kcylp/laoyin-plc-ai/main/work/green-build/LaoyinPLC-Green-v1.0.1.zip';
const MAX_PACKAGE_BYTES = 250 * 1024 * 1024;

function compareVersions(left, right) {
    const a = String(left || '').split('.').map(Number);
    const b = String(right || '').split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const av = Number.isInteger(a[i]) ? a[i] : 0;
        const bv = Number.isInteger(b[i]) ? b[i] : 0;
        if (av !== bv) return av > bv ? 1 : -1;
    }
    return 0;
}

function isVersion(value) {
    return /^\d+\.\d+\.\d+$/.test(String(value || ''));
}

function isHttpsGitHubUrl(value) {
    try {
        const url = new URL(String(value || ''));
        return url.protocol === 'https:' &&
            (url.hostname === 'raw.githubusercontent.com' || url.hostname === 'github.com');
    } catch {
        return false;
    }
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = require('node:fs').createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function validateManifest(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('manifest_invalid');
    const version = String(raw.version || '');
    const packageUrl = String(raw.packageUrl || '');
    const sha256 = String(raw.sha256 || '').toLowerCase();
    const sizeBytes = Number(raw.sizeBytes);
    let packagePath = '';
    try { packagePath = new URL(packageUrl).pathname; } catch { /* invalid URL handled below */ }
    if (!isVersion(version) || !isHttpsGitHubUrl(packageUrl) || !/\.zip$/i.test(packagePath)) {
        throw new Error('manifest_invalid');
    }
    if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_PACKAGE_BYTES) {
        throw new Error('manifest_invalid');
    }
    return Object.freeze({
        product: String(raw.product || '老殷工控PLC助手'),
        version, packageUrl, sha256, sizeBytes,
        releaseNotes: String(raw.releaseNotes || ''),
        minLauncherVersion: String(raw.minLauncherVersion || '1.0.0'),
        publishedAt: String(raw.publishedAt || '')
    });
}

module.exports = { UPDATE_MANIFEST_URL, PACKAGE_URL, MAX_PACKAGE_BYTES, compareVersions, isVersion, isHttpsGitHubUrl, sha256File, validateManifest };
