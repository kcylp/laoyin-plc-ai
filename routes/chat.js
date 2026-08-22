const express = require('express');
const fs = require('fs');
const path = require('path');
const SYSTEM_PROMPTS = require('../prompts');
const { resolvePromptContent } = require('../prompt-router');

const VALID_LANGS = ['lad', 'fbd', 'scl', 'stl', 'graph'];
const SERIES_LANGS = {
    s200smart: ['lad', 'stl'],
    s1200: ['lad', 'fbd', 'scl', 'stl', 'graph'],
    s1500: ['lad', 'fbd', 'scl', 'stl', 'graph']
};
const DEFAULT_LANG = { s200smart: 'stl', s1200: 'scl', s1500: 'scl' };
const SCHEMA_COUNT_CACHED = (() => {
    try {
        return fs.readdirSync(path.join(process.env.APP_ROOT || path.join(__dirname, '..'), 'engine', 'schemas'))
            .filter(file => file.toLowerCase().endsWith('.xsd')).length;
    } catch (e) {
        return 0;
    }
})();

module.exports = function createChatRoutes(deps) {
    const { db, authenticateToken, getUserById, getCurrentModel, setCurrentModel, llmStream, listUserModels, registrationApprovalRequired } = deps;
    const router = express.Router();

router.get('/workbench/status', authenticateToken, (req, res) => {
    const user = getUserById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });

    let providerCount = 0;
    let modelCount = 0;
    let currentModel = { id: null, label: '' };
    let currentModelTestStatus = 'unknown';
    let currentModelTestMessage = '';
    try {
        providerCount = db.prepare('SELECT COUNT(*) c FROM ai_providers WHERE user_id = ?').get(req.user.id).c;
        modelCount = db.prepare(`
            SELECT COUNT(*) c FROM ai_models m
            JOIN ai_providers p ON p.id = m.provider_id
            WHERE p.user_id = ? AND m.enabled = 1
        `).get(req.user.id).c;
        currentModel = getCurrentModel(req.user.id);

        // 当前模型 db<pid>/<modelId> → 查 ai_models 的模型级测试状态（不能继承供应商状态）；
        // 查不到该模型行 / 非 db 前缀（如内置官方模型）一律 unknown，绝不默认 passed
        const mid = String(currentModel.id || '');
        const midMatch = mid.match(/^db(\d+)\/([\s\S]+)$/);
        if (midMatch) {
            const mrow = db.prepare(`
                SELECT am.test_status, am.test_message
                FROM ai_models am
                JOIN ai_providers p ON p.id = am.provider_id
                WHERE am.provider_id = ? AND am.model_id = ? AND p.user_id = ? AND am.enabled = 1
            `).get(parseInt(midMatch[1], 10), midMatch[2], req.user.id);
            if (mrow) {
                currentModelTestStatus = mrow.test_status || 'unknown';
                currentModelTestMessage = mrow.test_message || '';
            }
        }
    } catch (e) { /* 保持 0/unknown，状态接口不阻塞工作台 */ }

    res.json({
        success: true,
        status: {
            user: { name: user.username, status: user.status, isPremium: !!user.is_premium },
            ai: { providerCount, modelCount, ready: modelCount > 0, currentModelId: currentModel.id, currentModelLabel: currentModel.label, currentModelTestStatus, currentModelTestMessage },
            tia: { mode: '本机预检 + 人工确认写入', autoWrite: false },
            mail: { configured: !!process.env.SMTP_PASS },
            registration: { approvalRequired: registrationApprovalRequired },
            runtime: { node: process.version },
            schemaCount: SCHEMA_COUNT_CACHED
        }
    });
});

// ---------- 路由: 问题次数（所有用户无限制） ----------
router.get('/check-questions', authenticateToken, (req, res) => {
    res.json({
        success: true,
        canAsk: true,
        questionsRemaining: -1,
        isPremium: true
    });
});

router.post('/use-question', authenticateToken, (req, res) => {
    res.json({ success: true, questionsRemaining: -1, isPremium: true });
});

// ---------- 路由: AI 对话（后端代理，流式） ----------
const conversationStore = new Map(); // userId -> [{role, content}]
const MAX_HISTORY = 30;

router.post('/chat', authenticateToken, async (req, res) => {
    const { message, series, modelId } = req.body;

    if (!message || !message.trim()) return res.status(400).json({ success: false, message: '消息不能为空' });
    if (!['s200smart', 's1200', 's1500'].includes(series)) {
        return res.status(400).json({ success: false, message: 'PLC系列不正确' });
    }
    let lang = String(req.body.lang || '').toLowerCase();
    if (!VALID_LANGS.includes(lang) || !SERIES_LANGS[series].includes(lang)) {
        lang = DEFAULT_LANG[series];
    }

    const user = getUserById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });
    if (user.status !== 'approved') {
        return res.status(403).json({ success: false, message: '账号未通过审批，无法使用' });
    }

    // 所有用户无限制提问，不扣次数
    // 系统提示词必须与用户选择的系列×语言完全匹配，禁止跨语言回退。
    const systemPrompt = resolvePromptContent(SYSTEM_PROMPTS, series, lang);
    if (!systemPrompt) {
        return res.status(422).json({
            success: false,
            message: `当前组合尚未完成真实模板验证：${series}_${lang}`
        });
    }
    const models = listUserModels(req.user.id);
    const requestedModelId = String(modelId || '').trim();
    const selectedModel = models.find(model => model.id === requestedModelId) || getCurrentModel(req.user.id, models);
    if (!selectedModel.id) {
        return res.status(422).json({
            success: false,
            message: '当前账号没有已启用模型，请先在设置页保存所选模型'
        });
    }

    const history = conversationStore.get(req.user.id) || [];
    const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: message }
    ];

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let fullText = '';
    const sendSSE = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    try {
        const full = await llmStream({
            modelId: selectedModel.id,
            userId: req.user.id,
            messages,
            signal: req.signal,
            onDelta: (delta) => {
                fullText += delta;
                sendSSE('delta', { content: delta });
            }
        });

        // 更新对话历史
        history.push({ role: 'user', content: message });
        history.push({ role: 'assistant', content: fullText });
        if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
        conversationStore.set(req.user.id, history);

        sendSSE('done', { content: fullText });
        res.end();
    } catch (error) {
        console.error('AI对话错误:', error.message);
        sendSSE('error', { message: error.message });
        res.end();
    }
});


// ---------- 路由: 清空对话 ----------
router.post('/chat/clear', authenticateToken, (req, res) => {
    conversationStore.delete(req.user.id);
    res.json({ success: true, message: '对话已清空' });
});

// ---------- 路由: 获取模型列表（按用户） ----------
router.get('/models', authenticateToken, (req, res) => {
    const models = listUserModels(req.user.id);
    const currentModel = getCurrentModel(req.user.id, models);
    res.json({
        success: true,
        models,
        currentModelId: currentModel.id,
        currentModelLabel: currentModel.label
    });
});

router.post('/models/current', authenticateToken, (req, res) => {
    const modelId = String(req.body.modelId || '').trim();
    if (!modelId) return res.status(400).json({ success: false, message: '模型不能为空' });

    const result = setCurrentModel(req.user.id, modelId);
    if (!result.ok) {
        return res.status(400).json({ success: false, message: '所选模型未启用，请先在设置页保存该模型' });
    }
    res.json({ success: true, currentModelId: result.model.id, currentModelLabel: result.model.label || result.model.id });
});

    return router;
};
