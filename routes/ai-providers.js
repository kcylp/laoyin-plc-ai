const express = require('express');
const { normalizeSelectedModels } = require('../ai-models');
const { fetchModelList, probeChatModel } = require('../llm');

module.exports = function createAiProviderRoutes(deps) {
    const { db, authenticateToken, localOnly, JWT_SECRET, getCurrentModel, setProviderTestStatus, setModelTestStatus } = deps;
    const router = express.Router();

// ---------- 路由: AI 供应商管理（每用户独立） ----------
// 列出当前用户的供应商（Key 只给掩码，附带已启用模型供卡片展示）
router.get('/providers', authenticateToken, (req, res) => {
    const { decrypt, maskKey } = require('../crypto-util');
    const rows = db.prepare('SELECT * FROM ai_providers WHERE user_id = ? ORDER BY id').all(req.user.id);
    const currentModel = getCurrentModel(req.user.id);
    const masked = rows.map(r => ({
        id: r.id,
        name: r.name,
        base_url: r.base_url,
        api_key_masked: maskKey(decrypt(r.api_key, JWT_SECRET)),
        wire_api: r.wire_api,
        testStatus: r.test_status || 'unknown',
        testMessage: r.test_message || '',
        testedAt: r.tested_at || '',
        models: db.prepare('SELECT id, model_id, label, context_length, enabled, test_status, test_message, tested_at FROM ai_models WHERE provider_id = ? AND enabled = 1 ORDER BY id').all(r.id)
    }));
    res.json({ success: true, providers: masked, currentModelId: currentModel.id, currentModelLabel: currentModel.label });
});

// 新增/更新供应商
router.post('/providers', authenticateToken, (req, res) => {
    const { id, name, base_url, api_key, wire_api } = req.body;
    if (!name || !base_url) {
        return res.status(400).json({ success: false, message: '供应商名称和 Base URL 不能为空' });
    }

    const { encrypt, isMasked } = require('../crypto-util');

    if (id) {
        // 更新已有
        const existing = db.prepare('SELECT * FROM ai_providers WHERE id = ? AND user_id = ?').get(id, req.user.id);
        if (!existing) return res.status(404).json({ success: false, message: '供应商不存在' });

        let finalKey = existing.api_key;
        if (api_key && !isMasked(api_key)) {
            finalKey = encrypt(api_key, JWT_SECRET);
        }
        // 名称/地址/Key/协议任一变更，旧测试结果不再可信，重置为 unknown
        db.prepare(`
            UPDATE ai_providers
            SET name=?, base_url=?, api_key=?, wire_api=?,
                test_status = 'unknown',
                test_message = '',
                tested_at = NULL
            WHERE id=?
        `).run(name, base_url, finalKey, wire_api || 'auto', id);
        return res.json({ success: true, id });
    }

    // 新增
    const enc = encrypt(api_key || '', JWT_SECRET);
    const r = db.prepare('INSERT INTO ai_providers (user_id, name, base_url, api_key, wire_api) VALUES (?,?,?,?,?)')
        .run(req.user.id, name, base_url, enc, wire_api || 'auto');
    res.json({ success: true, id: r.lastInsertRowid });
});

// 查看完整 Key（仅本机可调用；前端眼睛切换显示明文用）
router.get('/providers/:id/key', authenticateToken, localOnly, (req, res) => {
    const pid = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT api_key FROM ai_providers WHERE id = ? AND user_id = ?').get(pid, req.user.id);
    if (!row) return res.status(404).json({ success: false, message: '供应商不存在' });
    const { decrypt } = require('../crypto-util');
    res.json({ success: true, key: decrypt(row.api_key, JWT_SECRET) });
});

// 使用数据库中已保存的供应商配置测试连接，不向前端返回明文 Key。
// 双步判定：先读模型列表，再取第一个模型探测真实聊天通道；两步都成功才是 passed。
router.post('/providers/:id/test', authenticateToken, async (req, res) => {
    const pid = parseInt(req.params.id, 10);
    const existing = db.prepare('SELECT * FROM ai_providers WHERE id = ? AND user_id = ?').get(pid, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: '供应商不存在' });

    const { decrypt } = require('../crypto-util');
    const key = decrypt(existing.api_key, JWT_SECRET);
    const r = await fetchModelList(existing.base_url, key, existing.wire_api);
    if (!r.ok) {
        setProviderTestStatus(pid, 'failed', r.message);
        return res.status(400).json({ success: false, testStatus: 'failed', testMessage: r.message, message: r.message });
    }
    if (!r.models.length) {
        setProviderTestStatus(pid, 'failed', '模型列表为空');
        return res.status(400).json({ success: false, testStatus: 'failed', testMessage: '模型列表为空', message: '模型列表为空' });
    }

    // 模型列表可读 ≠ 聊天通道可用：用第一个模型探测真实通道
    const probe = await probeChatModel({
        baseUrl: existing.base_url,
        apiKey: key,
        wireApi: existing.wire_api,
        model: r.models[0].id,
        providerName: existing.name,
    });
    if (!probe.ok) {
        setProviderTestStatus(pid, 'failed', probe.message);
        // 列表已读到，仍返回模型供前端预览；但状态必须是 failed，不是 passed
        return res.json({ success: true, wireApi: r.wireApi, count: r.models.length, models: r.models, testStatus: 'failed', testMessage: probe.message });
    }
    setProviderTestStatus(pid, 'passed', '');
    res.json({ success: true, wireApi: r.wireApi, count: r.models.length, models: r.models, testStatus: 'passed', testMessage: '' });
});

// 删除供应商（连带删它的模型）
router.delete('/providers/:id', authenticateToken, (req, res) => {
    const pid = parseInt(req.params.id, 10);
    const existing = db.prepare('SELECT * FROM ai_providers WHERE id = ? AND user_id = ?').get(pid, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: '供应商不存在' });
    db.prepare('DELETE FROM ai_models WHERE provider_id = ?').run(pid);
    db.prepare('DELETE FROM ai_providers WHERE id = ?').run(pid);
    res.json({ success: true, message: '已删除' });
});

// 拉模型列表（不落库，给前端预览勾选）
router.post('/fetch-models', authenticateToken, async (req, res) => {
    const { base_url, api_key, wire_api } = req.body;
    if (!base_url || !api_key) {
        return res.status(400).json({ success: false, message: '请填写 Base URL 和 API Key' });
    }
    const r = await fetchModelList(base_url, api_key, wire_api);
    if (!r.ok) return res.status(400).json({ success: false, message: r.message });
    res.json({ success: true, wireApi: r.wireApi, models: r.models });
});

// 保存用户勾选的模型到某供应商
router.post('/providers/:id/models', authenticateToken, async (req, res) => {
    const pid = parseInt(req.params.id, 10);
    const existing = db.prepare('SELECT * FROM ai_providers WHERE id = ? AND user_id = ?').get(pid, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: '供应商不存在' });

    const models = normalizeSelectedModels(req.body.models);
    if (!models.length) {
        return res.status(400).json({ success: false, message: '请至少选择一个模型' });
    }

    const { decrypt } = require('../crypto-util');
    // 网络探测在事务外执行（不持长事务）；探测结果随保存一起落库，回滚则状态一并回滚
    const probe = await probeChatModel({
        baseUrl: existing.base_url,
        apiKey: decrypt(existing.api_key, JWT_SECRET),
        wireApi: existing.wire_api,
        model: models[0].id,
        providerName: existing.name,
    });
    const probeWarning = probe.ok ? '' : probe.message;

    const ins = db.prepare('INSERT INTO ai_models (provider_id, model_id, label, context_length, enabled) VALUES (?,?,?,?,?)');
    try {
        db.exec('BEGIN IMMEDIATE');
        db.prepare('DELETE FROM ai_models WHERE provider_id = ?').run(pid);
        let firstModelRowId = null;
        for (const m of models) {
            const r = ins.run(pid, m.id, m.label, m.context_length, m.enabled);
            if (firstModelRowId === null) firstModelRowId = r.lastInsertRowid;
        }
        // 模型级状态：仅首选模型写入探测结果（passed/failed），其余模型保持 unknown（INSERT 默认），
        // 避免未测试模型继承绿色；供应商级总灯同步（设置页供应商卡片用）
        const probeStatus = probe.ok ? 'passed' : 'failed';
        const probeMsg = probe.ok ? '' : (probe.message || '聊天通道测试失败');
        if (firstModelRowId !== null) setModelTestStatus(firstModelRowId, probeStatus, probeMsg);
        setProviderTestStatus(pid, probeStatus, probeMsg);
        db.prepare(`
            INSERT INTO user_settings (user_id, current_model_id, updated_at)
            VALUES (?, ?, datetime('now','localtime'))
            ON CONFLICT(user_id) DO UPDATE SET
                current_model_id = excluded.current_model_id,
                updated_at = excluded.updated_at
        `).run(req.user.id, `db${pid}/${models[0].id}`);
        db.exec('COMMIT');
    } catch (error) {
        try { db.exec('ROLLBACK'); } catch (_) { /* transaction may not have started */ }
        console.error('保存供应商模型失败:', error.message);
        return res.status(500).json({ success: false, message: '保存模型失败，请重试' });
    }
    res.json({ success: true, count: models.length, currentModelId: `db${pid}/${models[0].id}`, currentModelLabel: models[0].label || models[0].id, probeWarning, testStatus: probe.ok ? 'passed' : 'failed', testMessage: probe.ok ? '' : (probe.message || '聊天通道测试失败') });
});


    return router;
};
