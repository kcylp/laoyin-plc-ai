const { db } = require('./db');

const DEFAULT_HISTORY_LIMITS = Object.freeze({
    maxBlockEntries: 30,
    maxUserEntries: 500,
    maxUserBytes: 200 * 1024 * 1024,
});

function positiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveHistoryLimits(options = {}) {
    return {
        maxBlockEntries: positiveInt(options.maxBlockEntries, DEFAULT_HISTORY_LIMITS.maxBlockEntries),
        maxUserEntries: positiveInt(options.maxUserEntries, DEFAULT_HISTORY_LIMITS.maxUserEntries),
        maxUserBytes: positiveInt(options.maxUserBytes, DEFAULT_HISTORY_LIMITS.maxUserBytes),
    };
}

// 写入历史:每次成功写入博途留一份该块当时的完整内容快照,支持查看/回滚
// (覆盖写错后能回到上一版;每块保留最近 30 条,超量删最旧)
function recordWriteHistory(userId, info, options = {}) {
    const { blockName, blockType, kind, language, content, overwrite } = info;
    if (!blockName || content == null) return;
    const limits = resolveHistoryLimits(options);
    db.prepare(`
        INSERT INTO tia_write_history (user_id, block_name, block_type, kind, language, content, overwrite)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, String(blockName), String(blockType || ''), String(kind || ''), String(language || ''), String(content), overwrite ? 1 : 0);
    // 每块保留最近 30 条,防无限增长
    db.prepare(`
        DELETE FROM tia_write_history
        WHERE user_id = ? AND block_name = ?
          AND id NOT IN (SELECT id FROM tia_write_history WHERE user_id = ? AND block_name = ? ORDER BY id DESC LIMIT ?)
    `).run(userId, String(blockName), userId, String(blockName), limits.maxBlockEntries);
    db.prepare(`
        DELETE FROM tia_write_history
        WHERE user_id = ?
          AND id NOT IN (SELECT id FROM tia_write_history WHERE user_id = ? ORDER BY id DESC LIMIT ?)
    `).run(userId, userId, limits.maxUserEntries);
    let totalBytes = db.prepare(`
        SELECT COALESCE(SUM(length(CAST(content AS BLOB))), 0) AS bytes
        FROM tia_write_history
        WHERE user_id = ?
    `).get(userId).bytes || 0;
    while (totalBytes > limits.maxUserBytes) {
        const oldest = db.prepare('SELECT id, length(CAST(content AS BLOB)) AS bytes FROM tia_write_history WHERE user_id = ? ORDER BY id ASC LIMIT 1').get(userId);
        if (!oldest) break;
        db.prepare('DELETE FROM tia_write_history WHERE id = ? AND user_id = ?').run(oldest.id, userId);
        totalBytes -= Number(oldest.bytes || 0);
    }
}

function listHistory(userId, blockName) {
    return blockName
        ? db.prepare(`SELECT id, block_name, block_type, kind, language, overwrite, created_at
                      FROM tia_write_history WHERE user_id = ? AND block_name = ?
                      ORDER BY id DESC LIMIT 30`).all(userId, blockName)
        : db.prepare(`SELECT id, block_name, block_type, kind, language, overwrite, created_at
                      FROM tia_write_history WHERE user_id = ?
                      ORDER BY id DESC LIMIT 50`).all(userId);
}

function getHistoryVersion(userId, id) {
    return db.prepare('SELECT * FROM tia_write_history WHERE id = ? AND user_id = ?').get(id, userId);
}

module.exports = { DEFAULT_HISTORY_LIMITS, recordWriteHistory, listHistory, getHistoryVersion, resolveHistoryLimits };
