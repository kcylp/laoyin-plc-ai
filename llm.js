// ============================================================
// 老殷工控PLC - LLM 客户端
// 两种数据来源：
//   1. 内置默认（.env 里的 DEEPSEEK/K3）—— 兼容旧配置
//   2. 用户自定义供应商（数据库 ai_providers 表）—— 主路径
// 两种线路协议：
//   openai    -> /chat/completions + /models
//   anthropic -> /v1/messages + /v1/models
// 端点带 /anthropic 结尾自动判 Anthropic，否则 OpenAI。
// ============================================================

const crypto = require('crypto');
let db = null;
let jwtSecret = '';

// 按 base URL 判协议：/anthropic 结尾走 Anthropic，其余走 OpenAI
function detectWireApi(baseUrl) {
    const b = String(baseUrl || '').replace(/\/+$/, '');
    return /\/anthropic$/i.test(b) ? 'anthropic' : 'openai';
}

// 内置默认供应商（.env 兼容）
const ENV_PROVIDERS = {
    deepseek: {
        name: 'DeepSeek',
        baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
        apiKey: process.env.DEEPSEEK_API_KEY || '',
        models: {
            'deepseek-v4-flash': { label: 'DeepSeek V4 Flash' },
            'deepseek-v4-pro': { label: 'DeepSeek V4 Pro' }
        }
    },
    k3: {
        name: 'K3',
        baseUrl: process.env.K3_BASE_URL || 'https://tokenhub.scjwb.com/v1',
        apiKey: process.env.K3_API_KEY || '',
        models: {
            'k3': { label: 'K3 (128K)' },
            'k3-256k': { label: 'K3 256K' },
            'K2.6': { label: 'K2.6 (128K)' },
            'kimi-k2.7-code': { label: 'Kimi K2.7 Code' }
        }
    }
};

// ---- 初始化：注入数据库和 JWT 密钥 ----
function init(_db, _jwtSecret) {
    db = _db;
    jwtSecret = _jwtSecret || '';
}

// ---- 从数据库读某个用户的供应商（P0-001: user_id 约束必须落在数据访问层） ----
function getProviderById(id, userId) {
    if (!db || !userId) return null;
    try {
        return db.prepare('SELECT * FROM ai_providers WHERE id = ? AND user_id = ?').get(id, userId);
    } catch (e) {
        return null;
    }
}

function getEnabledModelsByProvider(providerId) {
    if (!db) return [];
    try {
        return db.prepare(
            'SELECT * FROM ai_models WHERE provider_id = ? AND enabled = 1 ORDER BY id'
        ).all(providerId);
    } catch (e) {
        return [];
    }
}

// ---- 用户所有可用模型（下拉框用）----
function listUserModels(userId) {
    if (!db || !userId) return listModels();
    try {
        const providers = db.prepare('SELECT * FROM ai_providers WHERE user_id = ? ORDER BY id').all(userId);
        const out = [];
        for (const p of providers) {
            const models = getEnabledModelsByProvider(p.id);
            for (const m of models) {
                out.push({
                    id: `db${p.id}/${m.model_id}`,
                    provider: p.name,
                    model: m.model_id,
                    label: `${p.name} · ${m.label || m.model_id}`
                });
            }
        }
        return providers.length ? out : listModels();
    } catch (e) {
        return listModels();
    }
}

// 内置模型列表（无用户上下文时兜底）
function listModels() {
    const result = [];
    for (const [providerId, p] of Object.entries(ENV_PROVIDERS)) {
        for (const [model, meta] of Object.entries(p.models)) {
            result.push({
                id: `${providerId}/${model}`,
                provider: p.name,
                model,
                label: `${p.name} · ${meta.label}`
            });
        }
    }
    return result;
}

// 解密库里的 Key
function decryptKey(encrypted) {
    if (!jwtSecret) return '';
    try {
        const buf = Buffer.from(String(encrypted), 'base64');
        if (buf.length < 28) return '';
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(12, 28);
        const data = buf.subarray(28);
        const key = crypto.createHash('sha256').update(jwtSecret).digest();
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
        d.setAuthTag(tag);
        return d.update(data) + d.final('utf8');
    } catch (e) {
        return '';
    }
}

// ---- 解析 modelId（"db{id}/{model}" 或 "deepseek/{model}"）→ { baseUrl, apiKey, name, model } ----
function resolveModel(modelId, userId) {
    const [prefix, ...rest] = (modelId || '').split('/');
    const model = rest.join('/');

    // 数据库供应商：前缀 db{id}
    // P0-001: userId 为必需参数，缺省时不得查库命中任何供应商，
    // 直接落入内置路径——与"供应商不存在/越权"表现完全一致，不可区分。
    if (userId && prefix && /^db\d+$/.test(prefix)) {
        const pid = parseInt(prefix.slice(2), 10);
        const p = getProviderById(pid, userId);
        if (p) {
            return {
                baseUrl: (p.base_url || '').replace(/\/+$/, ''),
                apiKey: decryptKey(p.api_key),
                name: p.name,
                model,
                wireApi: p.wire_api === 'anthropic' ? 'anthropic'
                    : p.wire_api === 'openai' ? 'openai'
                    : detectWireApi(p.base_url)
            };
        }
    }

    // 内置供应商
    const p = ENV_PROVIDERS[prefix];
    if (p && model && p.models[model]) {
        return {
            baseUrl: p.baseUrl.replace(/\/+$/, ''),
            apiKey: p.apiKey,
            name: p.name,
            model,
            wireApi: detectWireApi(p.baseUrl)
        };
    }

    // 兜底：内置 k3-256k（已验证可用）
    const k = ENV_PROVIDERS.k3;
    return {
        baseUrl: k.baseUrl.replace(/\/+$/, ''),
        apiKey: k.apiKey,
        name: k.name,
        model: 'k3-256k',
        wireApi: 'openai'
    };
}

// ---- 调用 LLM，流式返回 ----
function chatTimeoutError() {
    const error = new Error('AI 生成超时（180 秒未完成），请稍后重试');
    error.code = 'AI_TIMEOUT';
    return error;
}

function chatAbortError() {
    const error = new Error('AI 生成已停止');
    error.code = 'ABORT_ERR';
    error.name = 'AbortError';
    return error;
}

function composeChatSignal(signal, timeoutMs = 180000) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (signal && typeof AbortSignal.any === 'function') {
        const combined = AbortSignal.any([signal, timeoutSignal]);
        return { signal: combined, cleanup: () => {}, isTimeout: () => timeoutSignal.aborted, isAborted: () => combined.aborted };
    }
    if (signal) {
        const controller = new AbortController();
        const forward = () => controller.abort(signal.reason || chatAbortError());
        const timeout = () => controller.abort(chatTimeoutError());
        if (signal.aborted) forward();
        else signal.addEventListener('abort', forward, { once: true });
        timeoutSignal.addEventListener('abort', timeout, { once: true });
        return {
            signal: controller.signal,
            cleanup: () => {
                signal.removeEventListener('abort', forward);
                timeoutSignal.removeEventListener('abort', timeout);
            },
            isTimeout: () => timeoutSignal.aborted,
            isAborted: () => controller.signal.aborted,
        };
    }
    return { signal: timeoutSignal, cleanup: () => {}, isTimeout: () => timeoutSignal.aborted, isAborted: () => timeoutSignal.aborted };
}

async function streamChat({ modelId, userId, messages, onDelta, signal }) {
    const resolved = resolveModel(modelId, userId);

    if (!resolved.apiKey) {
        throw new Error(`[${resolved.name}] 未配置 API Key，请在设置页填写`);
    }

    let url, body, headers;

    if (resolved.wireApi === 'anthropic') {
        const systemMsg = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
        const convo = messages.filter(m => m.role !== 'system');
        url = `${resolved.baseUrl}/v1/messages`;
        headers = {
            'Content-Type': 'application/json',
            'x-api-key': resolved.apiKey,
            'anthropic-version': '2023-06-01'
        };
        body = {
            model: resolved.model,
            max_tokens: 4000,
            temperature: 0.7,
            stream: true,
            messages: convo
        };
        if (systemMsg) body.system = systemMsg;
    } else {
        url = `${resolved.baseUrl}/chat/completions`;
        headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${resolved.apiKey}`
        };
        body = {
            model: resolved.model,
            messages,
            stream: true,
            temperature: 0.7,
            max_tokens: 4000
        };
    }

    const abortState = composeChatSignal(signal);
    let reader = null;

    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: abortState.signal
        });

        if (!resp.ok) {
            let errMsg = `HTTP ${resp.status}`;
            try {
                const j = await resp.json();
                errMsg = j.error?.message || j.message || errMsg;
            } catch (e) { /* ignore */ }
            throw new Error(formatProviderError(resolved.name, errMsg));
        }

        reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);
                    const delta = resolved.wireApi === 'anthropic'
                        ? (parsed.type === 'content_block_delta' ? parsed.delta?.text : null)
                        : parsed.choices?.[0]?.delta?.content;

                    if (delta) {
                        fullText += delta;
                        onDelta(delta);
                    }

                    if (resolved.wireApi === 'anthropic' && parsed.type === 'error') {
                        throw new Error(parsed.error?.message || 'Anthropic 流返回错误');
                    }
                } catch (e) {
                    if (e instanceof SyntaxError) continue;
                    throw e;
                }
            }
        }

        return fullText;
    } catch (error) {
        if (abortState.isTimeout()) throw chatTimeoutError();
        if (abortState.isAborted() || error.name === 'AbortError' || error.code === 'ABORT_ERR') throw chatAbortError();
        throw error;
    } finally {
        abortState.cleanup();
        if (reader && abortState.isAborted()) {
            try { await reader.cancel(); } catch { /* reader may already be closed */ }
        }
    }
}

function formatProviderError(providerName, rawMessage) {
    const name = String(providerName || 'AI 供应商').trim();
    const raw = String(rawMessage || '未知错误').trim();
    const noChannel = raw.match(/No available channel for model\s+(.+?)\s+under group\s+(.+?)\s+\(distributor\)/i);
    if (noChannel) {
        return `[${name}] 模型 ${noChannel[1]} 在号池 ${noChannel[2]} 中没有可用聊天通道。请更换模型，或联系中转站开通该模型通道。`;
    }
    return `[${name}] ${raw}`;
}

// 模型列表可见不等于聊天线路可用。保存为工作台模型前，用最小请求验证真实通道。
async function probeChatModel({ baseUrl, apiKey, wireApi, model, providerName, fetchImpl = fetch }) {
    const b = String(baseUrl || '').replace(/\/+$/, '');
    const api = wireApi === 'anthropic' ? 'anthropic'
        : wireApi === 'openai' ? 'openai'
        : detectWireApi(b);
    const isAnthropic = api === 'anthropic';
    const url = isAnthropic ? `${b}/v1/messages` : `${b}/chat/completions`;
    const headers = isAnthropic
        ? {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        }
        : {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        };
    const body = isAnthropic
        ? {
            model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'Reply OK.' }],
        }
        : {
            model,
            messages: [{ role: 'user', content: 'Reply OK.' }],
            stream: false,
            temperature: 0,
            max_tokens: 1,
        };

    try {
        const resp = await fetchImpl(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
        });
        if (resp.ok) return { ok: true };

        let errMsg = `HTTP ${resp.status}`;
        try {
            const json = await resp.json();
            errMsg = json.error?.message || json.message || errMsg;
        } catch (_) { /* response may not be JSON */ }
        return { ok: false, message: formatProviderError(providerName, errMsg) };
    } catch (error) {
        return { ok: false, message: formatProviderError(providerName, error.message) };
    }
}

// ---- 拉取供应商的模型列表（设置页"获取模型"用）----
// 支持 OpenAI /models 和 Anthropic /v1/models 两套端点，格式容错。
async function fetchModelList(baseUrl, apiKey, wireApi) {
    const b = String(baseUrl || '').replace(/\/+$/, '');
    const api = wireApi === 'anthropic' ? 'anthropic' : detectWireApi(b);

    const endpoints = api === 'anthropic'
        ? [`${b}/v1/models`]
        : [`${b}/models`, `${b}/v1/models`];

    let lastErr = null;
    for (const url of endpoints) {
        try {
            const headers = api === 'anthropic'
                ? { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
                : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
            const resp = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(15000) });
            if (!resp.ok) {
                lastErr = `HTTP ${resp.status}`;
                continue;
            }
            const j = await resp.json();
            const list = extractModelArray(j);
            if (list.length) {
                return { ok: true, wireApi: api, models: list };
            }
            lastErr = '接口返回为空';
        } catch (e) {
            lastErr = e.message;
        }
    }
    return { ok: false, message: `获取模型失败: ${lastErr}` };
}

// 兼容 data / models / 裸数组 三种返回结构
function extractModelArray(json) {
    let arr = null;
    if (Array.isArray(json)) arr = json;
    else if (json && Array.isArray(json.data)) arr = json.data;
    else if (json && Array.isArray(json.models)) arr = json.models;
    if (!arr) return [];

    return arr
        .filter(m => m && m.id)
        .map(m => ({
            id: String(m.id),
            label: m.display_name || m.name || m.id,
            contextLength: m.context_length || m.max_context_length || m.context_window || null
        }));
}

// 判定"声明支持1M"：优先用返回的长度字段，其次匹配已知 1M 模型名
function isMillionContext(model, contextLength) {
    if (contextLength && contextLength >= 1000000) return true;
    if (!model) return false;
    const id = String(model.id || model.model_id || '').toLowerCase();
    if (/(^|[^a-z0-9])1m([^a-z0-9]|$)|-1m|_1m|1m-/.test(id)) return true;
    return false;
}

module.exports = {
    init, detectWireApi, listModels, listUserModels,
    resolveModel, streamChat, probeChatModel, formatProviderError,
    fetchModelList, extractModelArray, isMillionContext
};
