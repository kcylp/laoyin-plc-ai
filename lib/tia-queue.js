const crypto = require('crypto');

const tiaConfirmations = new Map();

// 博途操作互斥队列:自研引擎(preflight/import)与 MCP 层(connect/call)共享,
// 任何时刻只有一个操作在驱动博途——两条通道操作同一个 TIA 实例时不会撞车。
let tiaOpChain = Promise.resolve();
function enqueueTiaOp(fn) {
    const run = tiaOpChain.then(fn);
    tiaOpChain = run.catch(() => { /* 上一个操作的失败不阻塞队列 */ });
    return run;
}
const TIA_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

function sha256(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function issueTiaConfirmation(userId, xml, preflight) {
    const token = crypto.randomBytes(32).toString('hex');
    tiaConfirmations.set(token, {
        userId,
        xmlHash: sha256(xml),
        project: preflight.project || '',
        plc: preflight.plc || '',
        blockName: preflight.blockName || '',
        blockType: preflight.blockType || '',
        expiresAt: Date.now() + TIA_CONFIRMATION_TTL_MS
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

module.exports = { enqueueTiaOp, issueTiaConfirmation, consumeTiaConfirmation, sha256 };
