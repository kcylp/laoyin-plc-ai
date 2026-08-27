const express = require('express');
const fs = require('fs');
const path = require('path');
const SYSTEM_PROMPTS = require('../prompts');
const { resolvePromptContent, appendSystemMessage } = require('../prompt-router');
const { createProjectContextService } = require('../lib/project-context');
const { createKnowledgeService } = require('../lib/knowledge');

const VALID_LANGS = ['lad', 'fbd', 'scl', 'stl', 'graph'];
const SERIES_LANGS = {
    s200smart: ['lad', 'stl'],
    s1200: ['lad', 'fbd', 'scl', 'stl', 'graph'],
    s1500: ['lad', 'fbd', 'scl', 'stl', 'graph']
};
const DEFAULT_LANG = { s200smart: 'stl', s1200: 'scl', s1500: 'scl' };
const OFF_TOPIC_SOFT_GUIDANCE = [
    '你是 PLC/工控编程助手。若用户请求与工控、PLC、自动化完全无关（例如写诗、小说、通用闲聊），请礼貌说明你的专长，并简要列出你能帮助完成的 PLC 程序编写、程序解释、故障诊断、博途写入与环境诊断。',
    '宁可回答不可误拒：工艺描述、动作时序、设备口语化需求、缺少 PLC 关键词的描述（例如“两台泵轮换运行，间隔30秒”）一律视为工控需求正常回答。'
].join('\n');
const SCHEMA_COUNT_CACHED = (() => {
    try {
        return fs.readdirSync(path.join(process.env.APP_ROOT || path.join(__dirname, '..'), 'engine', 'schemas'))
            .filter(file => file.toLowerCase().endsWith('.xsd')).length;
    } catch (e) {
        return 0;
    }
})();

module.exports = function createChatRoutes(deps) {
    const { db, authenticateToken, getUserById, getCurrentModel, setCurrentModel, llmStream, listUserModels, registrationApprovalRequired, enqueueTiaOp, mcpEnsureAttached, parseBlocksFromTree } = deps;
    const projectContext = createProjectContextService({
        enqueueTiaOp,
        mcpEnsureAttached,
        parseBlocksFromTree,
        getWriteRevision: (userId) => {
            try {
                const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS revision FROM tia_write_history WHERE user_id = ?').get(userId);
                return row ? row.revision : 0;
            } catch {
                return 0;
            }
        }
    });
    const knowledge = createKnowledgeService();
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
const MAX_HISTORY = 30;
const DEFAULT_KNOWLEDGE_TOP_N = 3;
const DEFAULT_KNOWLEDGE_MAX_CHARS = 9000;

function clampInt(value, min, max, fallback) {
    const num = Number.parseInt(value, 10);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
}

function normalizeHistory(messages) {
    if (!Array.isArray(messages)) return [];
    return messages
        .filter(item => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
        .map(item => ({ role: item.role, content: item.content }))
        .slice(-MAX_HISTORY);
}

function loadConversation(userId) {
    try {
        const row = db.prepare('SELECT messages_json FROM conversations WHERE user_id = ?').get(userId);
        if (!row || !row.messages_json) return [];
        return normalizeHistory(JSON.parse(row.messages_json));
    } catch {
        return [];
    }
}

function saveConversation(userId, messages) {
    const normalized = normalizeHistory(messages);
    db.prepare(`
        INSERT INTO conversations (user_id, messages_json, updated_at)
        VALUES (?, ?, datetime('now','localtime'))
        ON CONFLICT(user_id) DO UPDATE SET
            messages_json = excluded.messages_json,
            updated_at = excluded.updated_at
    `).run(userId, JSON.stringify(normalized));
    return normalized;
}

function clearConversation(userId) {
    db.prepare('DELETE FROM conversations WHERE user_id = ?').run(userId);
}

router.get('/chat/history', authenticateToken, (req, res) => {
    res.json({ success: true, messages: loadConversation(req.user.id) });
});

// ---------- 路由: 知识库（TASK-012） ----------
router.get('/knowledge/index', authenticateToken, (req, res) => {
    res.json({ success: true, entries: knowledge.listKnowledgeDocs() });
});

router.get('/knowledge/scenarios', authenticateToken, (req, res) => {
    res.json({ success: true, scenarios: knowledge.getScenarioCards(12) });
});

router.get('/knowledge/search', authenticateToken, (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = clampInt(req.query.limit, 1, 10, DEFAULT_KNOWLEDGE_TOP_N);
    res.json({ success: true, q, results: q ? knowledge.searchKnowledge(q, { limit }) : [] });
});

router.get('/knowledge/doc/:id', authenticateToken, (req, res) => {
    try {
        res.json({ success: true, doc: knowledge.readKnowledgeDoc(req.params.id) });
    } catch (e) {
        const code = e.code === 'NOT_FOUND' ? 404 : 500;
        res.status(code).json({ success: false, message: e.message || '读取知识库失败' });
    }
});

router.post('/chat', authenticateToken, async (req, res) => {
    const { message, series, modelId, includeContext, projectContextEnabled, includeAllVariables } = req.body;

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

    let history = loadConversation(req.user.id);
    if (Array.isArray(req.body.history)) {
        history = normalizeHistory(req.body.history);
    }
    if (req.body.regenerate === true) {
        if (history.length && history[history.length - 1].role === 'user' && history[history.length - 1].content === message) {
            history = history.slice(0, -1);
        } else {
            while (history.length && history[history.length - 1].role !== 'user') history.pop();
            if (history.length && history[history.length - 1].content === message) history.pop();
        }
    } else if (history.length && history[history.length - 1].role === 'user' && history[history.length - 1].content === message) {
        history = history.slice(0, -1);
    }
    const messages = [];
    appendSystemMessage(messages, systemPrompt);
    appendSystemMessage(messages, OFF_TOPIC_SOFT_GUIDANCE);

    const contextEnabled = includeContext !== false && projectContextEnabled !== false;
    let contextResult = {
        prompt: '',
        status: { enabled: false, connected: false, project: '', blockCount: 0, variableCount: 0, totalVars: 0, charCount: 0, tokenEstimate: 0 },
        details: null
    };
    if (contextEnabled) {
        try {
            contextResult = await projectContext.getPromptContext({
                userId: req.user.id,
                message,
                includeAllVariables: includeAllVariables === true
            });
            if (contextResult.prompt) {
                appendSystemMessage(messages, contextResult.prompt);
            }
        } catch (e) {
            console.error('项目上下文注入失败:', e.message);
            contextResult.status = { ...contextResult.status, enabled: true, connected: false, error: e.message };
        }
    }

    const knowledgeEnabled = req.body.knowledgeEnabled !== false;
    let knowledgeResult = {
        prompt: '',
        status: { enabled: false, workflow: null, matches: [], charCount: 0, tokenEstimate: 0, truncated: false, pendingSectionsFiltered: 0 },
        docs: []
    };
    if (knowledgeEnabled) {
        try {
            knowledgeResult = knowledge.buildKnowledgePrompt({
                message,
                projectContextStatus: contextResult.status,
                limit: clampInt(req.body.knowledgeTopN, 1, 3, DEFAULT_KNOWLEDGE_TOP_N),
                maxPromptChars: clampInt(req.body.knowledgeMaxPromptChars, 2500, DEFAULT_KNOWLEDGE_MAX_CHARS, DEFAULT_KNOWLEDGE_MAX_CHARS)
            });
            appendSystemMessage(messages, knowledgeResult.prompt);
        } catch (e) {
            console.error('知识库上下文注入失败:', e.message);
            knowledgeResult.status = {
                enabled: true,
                error: e.message,
                workflow: null,
                matches: [],
                charCount: 0,
                tokenEstimate: 0,
                truncated: false,
                pendingSectionsFiltered: 0
            };
        }
    }

    messages.push(
        ...history,
        { role: 'user', content: message }
    );

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let fullText = '';
    let responseFinished = false;
    const abortController = new AbortController();
    const abortOnClose = () => {
        if (!responseFinished && !abortController.signal.aborted) {
            abortController.abort(new Error('client closed'));
        }
    };
    req.on('aborted', abortOnClose);
    res.on('close', abortOnClose);
    const sendSSE = (type, data) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    const finish = () => {
        responseFinished = true;
        req.off('aborted', abortOnClose);
        res.off('close', abortOnClose);
        if (!res.writableEnded) res.end();
    };

    try {
        sendSSE('context', { projectContext: contextResult.status, knowledgeContext: knowledgeResult.status, details: contextResult.details });
        const full = await llmStream({
            modelId: selectedModel.id,
            userId: req.user.id,
            messages,
            signal: abortController.signal,
            onDelta: (delta) => {
                fullText += delta;
                sendSSE('delta', { content: delta });
            }
        });

        // 更新对话历史
        if (full && full !== fullText) fullText = full;
        history.push({ role: 'user', content: message });
        history.push({ role: 'assistant', content: fullText });
        saveConversation(req.user.id, history);

        sendSSE('done', { content: fullText });
        finish();
    } catch (error) {
        const aborted = abortController.signal.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR' || error.code === 'AI_TIMEOUT';
        if (aborted) {
            if (abortController.signal.aborted && error.code !== 'AI_TIMEOUT') {
                history.push({ role: 'user', content: message });
                history.push({ role: 'assistant', content: '[用户已中断]' });
                saveConversation(req.user.id, history);
            }
            sendSSE('aborted', { message: error.code === 'AI_TIMEOUT' ? error.message : 'AI 生成已停止' });
        } else {
            console.error('AI对话错误:', error.message);
            sendSSE('error', { message: error.message });
        }
        finish();
    }
});


// ---------- 路由: 项目上下文（TASK-009） ----------
router.get('/chat/context', authenticateToken, (req, res) => {
    res.json({ success: true, context: projectContext.getStatus(req.user.id) });
});

router.post('/chat/context/refresh', authenticateToken, async (req, res) => {
    try {
        const result = await projectContext.refresh({
            userId: req.user.id,
            message: String(req.body && req.body.message || ''),
            includeAllVariables: !!(req.body && req.body.includeAllVariables)
        });
        res.json({ success: true, context: result.status, details: result.details, summary: result.prompt });
    } catch (e) {
        res.status(500).json({ success: false, message: '刷新上下文失败: ' + e.message });
    }
});

// ---------- 路由: 清空对话 ----------
router.post('/chat/clear', authenticateToken, (req, res) => {
    clearConversation(req.user.id);
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
