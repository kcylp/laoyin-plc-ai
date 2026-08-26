const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), '老殷工控PLC助手');
const LOG_DIR = path.join(APP_DATA_DIR, 'logs');
const TIA_OPS_LOG = path.join(LOG_DIR, 'tia-ops.jsonl');
const LEGACY_LOG_DIR = path.join(process.env.APP_ROOT || path.join(__dirname, '..'), 'work', 'logs');
const LEGACY_TIA_OPS_LOG = path.join(LEGACY_LOG_DIR, 'tia-ops.jsonl');
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_ROTATED_LOGS = 5;

function copyLegacyLogOnce() {
    if (LEGACY_TIA_OPS_LOG === TIA_OPS_LOG || !fs.existsSync(LEGACY_TIA_OPS_LOG) || fs.existsSync(TIA_OPS_LOG)) return;
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.copyFileSync(LEGACY_TIA_OPS_LOG, TIA_OPS_LOG);
    } catch (e) {
        console.warn('[tia-ops-log] legacy copy failed:', e.message);
    }
}

function rotateLogIfNeeded() {
    try {
        if (!fs.existsSync(TIA_OPS_LOG) || fs.statSync(TIA_OPS_LOG).size < MAX_LOG_BYTES) return;
        const oldest = path.join(LOG_DIR, `tia-ops.${MAX_ROTATED_LOGS}.jsonl`);
        if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
        for (let i = MAX_ROTATED_LOGS - 1; i >= 1; i--) {
            const src = path.join(LOG_DIR, `tia-ops.${i}.jsonl`);
            if (fs.existsSync(src)) fs.renameSync(src, path.join(LOG_DIR, `tia-ops.${i + 1}.jsonl`));
        }
        fs.renameSync(TIA_OPS_LOG, path.join(LOG_DIR, 'tia-ops.1.jsonl'));
    } catch (e) {
        console.warn('[tia-ops-log] rotate failed:', e.message);
    }
}

function fallbackUserName() {
    try {
        return os.userInfo().username || 'unknown';
    } catch {
        return 'unknown';
    }
}

function currentUserName(user) {
    if (!user) return fallbackUserName();
    if (typeof user === 'string') return user;
    return String(user.username || user.name || user.id || fallbackUserName());
}

function normalizeError(err) {
    if (!err) return null;
    if (typeof err === 'string') return err;
    return String(err.message || err.code || err);
}

function logTiaOperation(entry) {
    const line = {
        ts: new Date().toISOString(),
        user: currentUserName(entry.user),
        op: String(entry.op || ''),
        target: entry.target == null ? '' : String(entry.target),
        ms: Math.max(0, Math.round(Number(entry.ms) || 0)),
        ok: entry.ok === true,
        err: normalizeError(entry.err),
    };

    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        copyLegacyLogOnce();
        rotateLogIfNeeded();
        fs.appendFileSync(TIA_OPS_LOG, JSON.stringify(line) + '\n', 'utf8');
    } catch (e) {
        console.warn('[tia-ops-log] write failed:', e.message);
    }

    return line;
}

module.exports = { logTiaOperation, TIA_OPS_LOG, LOG_DIR };
