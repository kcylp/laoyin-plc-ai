const { db } = require('./db');

// 写入历史:每次成功写入博途留一份该块当时的完整内容快照,支持查看/回滚
// (覆盖写错后能回到上一版;每块保留最近 30 条,超量删最旧)
function recordWriteHistory(userId, info) {
    const { blockName, blockType, kind, language, content, overwrite } = info;
    if (!blockName || content == null) return;
    db.prepare(`
        INSERT INTO tia_write_history (user_id, block_name, block_type, kind, language, content, overwrite)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, String(blockName), String(blockType || ''), String(kind || ''), String(language || ''), String(content), overwrite ? 1 : 0);
    // 每块保留最近 30 条,防无限增长
    db.prepare(`
        DELETE FROM tia_write_history
        WHERE user_id = ? AND block_name = ?
          AND id NOT IN (SELECT id FROM tia_write_history WHERE user_id = ? AND block_name = ? ORDER BY id DESC LIMIT 30)
    `).run(userId, String(blockName), userId, String(blockName));
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

module.exports = { recordWriteHistory, listHistory, getHistoryVersion };
