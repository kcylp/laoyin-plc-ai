const crypto = require('crypto');

const tiaConfirmations = new Map();

// 博途操作互斥队列:自研引擎(preflight/import)与 MCP 层(connect/call)共享,
// 任何时刻只有一个操作在驱动博途——两条通道操作同一个 TIA 实例时不会撞车。
let tiaOpChain = Promise.resolve();
let currentOp = null;
let nextOpId = 1;
const pendingOps = [];
const inFlightKeys = new Map();
const DEFAULT_TIMEOUT_MS = 600000;

function describeOp(label) {
    const text = String(label || '').trim();
    return text || '博途操作';
}

function removePending(id) {
    const index = pendingOps.findIndex(op => op.id === id);
    if (index >= 0) pendingOps.splice(index, 1);
}

function queueTimeoutError(label, timeoutMs) {
    const error = new Error(`${describeOp(label)} 超时（${Math.round(timeoutMs / 1000)} 秒未完成），已释放队列，请稍后重试`);
    error.code = 'TIA_QUEUE_TIMEOUT';
    error.statusCode = 504;
    return error;
}

function dedupeError(label) {
    const error = new Error(`相同操作「${describeOp(label)}」正在进行，请等待当前操作完成`);
    error.code = 'TIA_QUEUE_DUPLICATE';
    error.statusCode = 409;
    return error;
}

function snapshotOp(op) {
    if (!op) return null;
    return {
        id: op.id,
        label: op.label,
        key: op.key || '',
        enqueuedAt: op.enqueuedAt,
        startedAt: op.startedAt || null,
        waitMs: Date.now() - op.enqueuedAt,
        runMs: op.startedAt ? Date.now() - op.startedAt : 0,
    };
}

async function runQueuedOp(task, fn, timeoutMs) {
    removePending(task.id);
    task.startedAt = Date.now();
    currentOp = task;
    let timer = null;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const opPromise = Promise.resolve().then(() => fn(controller ? controller.signal : undefined));
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            if (controller) controller.abort();
            reject(queueTimeoutError(task.label, timeoutMs));
        }, timeoutMs);
    });
    try {
        return await Promise.race([opPromise, timeoutPromise]);
    } finally {
        if (timer) clearTimeout(timer);
        if (currentOp && currentOp.id === task.id) currentOp = null;
        if (task.key) inFlightKeys.delete(task.key);
        opPromise.catch(() => { /* 超时释放后，下游晚到失败不应制造未处理拒绝 */ });
    }
}

function enqueueTiaOp(fn, options = {}) {
    const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 1), DEFAULT_TIMEOUT_MS);
    const key = options.key ? String(options.key) : '';
    const label = describeOp(options.label);
    if (key && inFlightKeys.has(key)) {
        return Promise.reject(dedupeError(label));
    }

    const task = { id: nextOpId++, key, label, enqueuedAt: Date.now(), startedAt: null };
    pendingOps.push(task);
    const run = tiaOpChain.then(() => runQueuedOp(task, fn, timeoutMs));
    if (key) inFlightKeys.set(key, run);
    tiaOpChain = run.catch(() => { /* 上一个操作的失败不阻塞队列 */ });
    return run;
}
const TIA_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

function queueSnapshot() {
    const current = snapshotOp(currentOp);
    const pending = pendingOps.map(snapshotOp);
    return {
        depth: pending.length + (current ? 1 : 0),
        pendingCount: pending.length,
        current,
        pending,
    };
}

function cleanupExpiredTiaConfirmations(now = Date.now()) {
    let removed = 0;
    for (const [token, confirmation] of tiaConfirmations.entries()) {
        if (!confirmation || confirmation.expiresAt < now) {
            tiaConfirmations.delete(token);
            removed++;
        }
    }
    return removed;
}

const confirmationCleanupTimer = setInterval(() => cleanupExpiredTiaConfirmations(), 60000);
if (confirmationCleanupTimer.unref) confirmationCleanupTimer.unref();

function sha256(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function issueTiaConfirmation(userId, xml, preflight, options = {}) {
    const token = crypto.randomBytes(32).toString('hex');
    const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Number(options.ttlMs) : TIA_CONFIRMATION_TTL_MS;
    tiaConfirmations.set(token, {
        userId,
        xmlHash: sha256(xml),
        project: preflight.project || '',
        plc: preflight.plc || '',
        blockName: preflight.blockName || '',
        blockType: preflight.blockType || '',
        expiresAt: Date.now() + ttlMs
    });
    return token;
}

function consumeTiaConfirmation(userId, xml, confirmationToken) {
    const token = String(confirmationToken || '');
    const confirmation = tiaConfirmations.get(token);
    tiaConfirmations.delete(token);
    if (!confirmation || confirmation.expiresAt < Date.now() || confirmation.userId !== userId || confirmation.xmlHash !== sha256(xml)) {
        return null;
    }
    return confirmation;
}

function confirmationSnapshot() {
    cleanupExpiredTiaConfirmations();
    return { count: tiaConfirmations.size };
}

function _resetForTests() {
    tiaConfirmations.clear();
    pendingOps.splice(0, pendingOps.length);
    inFlightKeys.clear();
    currentOp = null;
    nextOpId = 1;
    tiaOpChain = Promise.resolve();
}

module.exports = {
    enqueueTiaOp,
    issueTiaConfirmation,
    consumeTiaConfirmation,
    sha256,
    queueSnapshot,
    cleanupExpiredTiaConfirmations,
    confirmationSnapshot,
    _resetForTests,
};
