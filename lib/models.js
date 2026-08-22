const { db } = require('./db');
const { listUserModels } = require('../llm');

function getUserByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}
function getUserById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// 供应商测试状态统一写入（unknown/testing/passed/failed）
function setProviderTestStatus(providerId, status, message = '') {
    db.prepare(`
        UPDATE ai_providers
        SET test_status = ?,
            test_message = ?,
            tested_at = datetime('now','localtime')
        WHERE id = ?
    `).run(status, message, providerId);
}

// 模型级测试状态统一写入（unknown/testing/passed/failed）
function setModelTestStatus(modelRowId, status, message = '') {
    db.prepare(`
        UPDATE ai_models
        SET test_status = ?,
            test_message = ?,
            tested_at = datetime('now','localtime')
        WHERE id = ?
    `).run(status, message, modelRowId);
}

function getCurrentModel(userId, models) {
    const available = Array.isArray(models) ? models : listUserModels(userId);
    if (!available.length) return { id: null, label: '' };

    let saved = '';
    try {
        const row = db.prepare('SELECT current_model_id FROM user_settings WHERE user_id = ?').get(userId);
        saved = String(row && row.current_model_id || '');
    } catch (e) { /* settings table should exist, but do not block the workbench */ }

    const selected = available.find(model => model.id === saved) || available[0];
    return { id: selected.id, label: selected.label || selected.model || selected.id };
}

function setCurrentModel(userId, modelId) {
    const available = listUserModels(userId);
    const selected = available.find(model => model.id === modelId);
    if (!selected) return { ok: false, available };
    db.prepare(`
        INSERT INTO user_settings (user_id, current_model_id, updated_at)
        VALUES (?, ?, datetime('now','localtime'))
        ON CONFLICT(user_id) DO UPDATE SET
            current_model_id = excluded.current_model_id,
            updated_at = excluded.updated_at
    `).run(userId, selected.id);
    return { ok: true, model: selected, available };
}

module.exports = {
    getUserByUsername,
    getUserById,
    setProviderTestStatus,
    setModelTestStatus,
    getCurrentModel,
    setCurrentModel,
};
