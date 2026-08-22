// Offline 60-day trial license. The record lives outside the portable package.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const APP_NAME = '老殷工控PLC助手';
const CONTACT = '请联系软件管理员续期';
const TRIAL_DAYS = 60;

function licenseDir() {
    return path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Local'), APP_NAME);
}

function licensePath() {
    return path.join(licenseDir(), 'license.json');
}

function markerPath() {
    return path.join(licenseDir(), 'trial.marker');
}

function fingerprint() {
    return crypto.createHash('sha256').update([
        process.env.ComSpec || '',
        process.env.USERNAME || '',
        process.env.USERDOMAIN || '',
    ].join('|')).digest('hex').slice(0, 32);
}

function seal(record) {
    const body = JSON.stringify({ startedAt: record.startedAt, machine: record.machine, version: 1 });
    return crypto.createHash('sha256').update(body + 'laoyin-offline-trial-v1').digest('hex');
}

function fail(code, message) {
    return { ok: false, code, message, contact: CONTACT };
}

function ensureLicense() {
    try {
        const dir = licenseDir();
        const file = licensePath();
        const marker = markerPath();
        fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(file)) {
            if (fs.existsSync(marker)) {
                return fail('INVALID', '授权文件无效，程序已停止。' + CONTACT);
            }
            const record = { startedAt: new Date().toISOString(), machine: fingerprint(), version: 1 };
            record.signature = seal(record);
            fs.writeFileSync(marker, JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
            fs.writeFileSync(file, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
            return statusFrom(record);
        }
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!record || !record.startedAt || !record.machine || !record.signature || record.version !== 1) {
            return fail('INVALID', '授权文件无效，程序已停止。' + CONTACT);
        }
        if (record.machine !== fingerprint() || record.signature !== seal(record)) {
            return fail('INVALID', '授权文件无效，程序已停止。' + CONTACT);
        }
        return statusFrom(record);
    } catch {
        return fail('INVALID', '授权校验失败，程序已停止。' + CONTACT);
    }
}

function statusFrom(record) {
    const started = Date.parse(record.startedAt);
    if (!Number.isFinite(started)) return fail('INVALID', '授权文件无效，程序已停止。' + CONTACT);
    const elapsed = Math.max(0, Date.now() - started);
    const remainingDays = Math.max(0, TRIAL_DAYS - Math.floor(elapsed / 86400000));
    if (remainingDays <= 0) return fail('EXPIRED', '试用授权已到期，程序无法启动。' + CONTACT);
    return { ok: true, remainingDays, trial: true, path: licensePath() };
}

function publicStatus() {
    const result = ensureLicense();
    if (!result.ok) return { ok: false, message: result.message, contact: CONTACT };
    return { ok: true, trial: true, remainingDays: result.remainingDays };
}

module.exports = { ensureLicense, publicStatus, licensePath, TRIAL_DAYS };
