const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOG_DIR = path.join(process.env.APP_ROOT || path.join(__dirname, '..'), 'work', 'logs');
const TIA_OPS_LOG = path.join(LOG_DIR, 'tia-ops.jsonl');

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
        fs.appendFileSync(TIA_OPS_LOG, JSON.stringify(line) + '\n', 'utf8');
    } catch (e) {
        console.warn('[tia-ops-log] write failed:', e.message);
    }

    return line;
}

module.exports = { logTiaOperation, TIA_OPS_LOG };
