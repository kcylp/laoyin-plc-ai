const TIA_ERROR_ACTIONS = ['运行环境诊断', '导出诊断包', '重新生成'];
const AI_PROVIDER_PRESETS = [
    { id: 'deepseek', name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', wire_api: 'openai' },
    { id: 'qwen', name: '通义千问', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', wire_api: 'openai' },
    { id: 'openai-compatible', name: 'OpenAI 兼容', base_url: 'https://api.openai.com/v1', wire_api: 'openai' }
];

function token() {
    return localStorage.getItem('token') || '';
}

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

async function jsonFetch(url, options = {}) {
    const headers = Object.assign({
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token()
    }, options.headers || {});
    const response = await fetch(url, { ...options, headers });
    const body = await response.json().catch(() => ({}));
    body.httpStatus = response.status;
    return body;
}

async function loadScenarios() {
    const body = await jsonFetch('/api/knowledge/scenarios');
    if (!body.success) throw new Error(body.message || '场景卡加载失败');
    return Array.isArray(body.scenarios) ? body.scenarios : [];
}

function scenarioButtons(scenarios) {
    return scenarios.map(item => (
        `<button class="scenario-card" type="button" data-scenario-id="${esc(item.id)}" data-prompt="${esc(item.prompt)}" title="填入「${esc(item.title)}」需求">${esc(item.title)}</button>`
    )).join('');
}

function bindScenarioClicks(root) {
    root.querySelectorAll('[data-scenario-id]').forEach(button => {
        button.addEventListener('click', () => {
            const input = document.getElementById('userInput');
            if (!input) return;
            input.value = button.dataset.prompt || '';
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
        });
    });
}

function presetOptions() {
    return AI_PROVIDER_PRESETS.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
}

function findPreset(id) {
    return AI_PROVIDER_PRESETS.find(item => item.id === id) || AI_PROVIDER_PRESETS[0];
}

function bindAiQuickSetup(root, onReady) {
    const select = root.querySelector('[data-ai-preset]');
    const baseInput = root.querySelector('[data-ai-base]');
    const keyInput = root.querySelector('[data-ai-key]');
    const saveBtn = root.querySelector('[data-ai-save]');
    const status = root.querySelector('[data-ai-status]');
    if (!select || !baseInput || !keyInput || !saveBtn || !status) return;

    const applyPreset = () => {
        const preset = findPreset(select.value);
        baseInput.value = preset.base_url;
        baseInput.dataset.providerName = preset.name;
        baseInput.dataset.wireApi = preset.wire_api;
    };
    select.addEventListener('change', applyPreset);
    applyPreset();

    saveBtn.addEventListener('click', async () => {
        const preset = findPreset(select.value);
        const apiKey = keyInput.value.trim();
        const baseUrl = baseInput.value.trim();
        if (!apiKey || !baseUrl) {
            status.textContent = '请先填写 Base URL 和 API Key。';
            return;
        }
        saveBtn.disabled = true;
        status.textContent = '正在保存供应商并测试连接...';
        try {
            const provider = await jsonFetch('/api/ai/providers', {
                method: 'POST',
                body: JSON.stringify({ name: preset.name, base_url: baseUrl, api_key: apiKey, wire_api: preset.wire_api })
            });
            if (!provider.success || !provider.id) throw new Error(provider.message || '保存供应商失败');

            const tested = await jsonFetch(`/api/ai/providers/${provider.id}/test`, { method: 'POST' });
            if (!tested.success || tested.testStatus === 'failed') {
                throw new Error(tested.testMessage || tested.message || '聊天通道测试失败');
            }
            const firstModel = Array.isArray(tested.models) ? tested.models[0] : null;
            if (!firstModel || !firstModel.id) throw new Error('没有识别到可启用模型');

            const saved = await jsonFetch(`/api/ai/providers/${provider.id}/models`, {
                method: 'POST',
                body: JSON.stringify({
                    models: [{
                        id: firstModel.id,
                        label: firstModel.label || firstModel.id,
                        context_length: firstModel.context_length || firstModel.contextLength || null,
                        enabled: true
                    }]
                })
            });
            if (!saved.success) throw new Error(saved.message || saved.testMessage || '启用模型失败');
            status.textContent = `已启用默认模型：${saved.currentModelLabel || firstModel.label || firstModel.id}`;
            keyInput.value = '';
            if (typeof onReady === 'function') onReady();
        } catch (error) {
            status.textContent = error.message || 'AI 配置失败';
        } finally {
            saveBtn.disabled = false;
        }
    });
}

function renderWelcome(scenarios) {
    const messages = document.getElementById('messages');
    if (!messages || messages.querySelector('[data-welcome-card]') || messages.querySelector('.message')) return;
    const card = document.createElement('section');
    card.className = 'welcome-card';
    card.dataset.welcomeCard = '1';
    card.innerHTML = `
        <h2>老殷工控 PLC 助手</h2>
        <div>我可以帮你写博途程序、解释现有程序、检查代码、直接写进工程。</div>
        <div class="scenario-grid">${scenarioButtons(scenarios)}</div>
        <div class="welcome-note">或者直接用大白话描述需求，例如“两台泵轮换运行，间隔30秒”。当前未连接博途时，生成的代码可以先复制到博途；连接后还能一键写入。 <button class="tia-btn is-ghost is-xs" type="button" data-connect-tia>连接博途</button></div>
    `;
    messages.appendChild(card);
    bindScenarioClicks(card);
    const connect = card.querySelector('[data-connect-tia]');
    if (connect) connect.addEventListener('click', () => {
        const btn = document.getElementById('btnTiaOnline');
        if (btn) btn.click();
    });
}

function renderBanner(hasModels) {
    const banner = document.getElementById('onboardingBanner');
    if (!banner) return;
    if (hasModels) {
        banner.classList.add('hidden');
        banner.innerHTML = '';
        return;
    }
    banner.innerHTML = `
        <span>还没有配置 AI 大模型，先保存供应商并启用模型后就能开始生成代码。</span>
        <span>
            <a class="tia-btn is-primary is-sm" href="settings.html">去配置</a>
            <button class="tia-btn is-ghost is-sm" type="button" data-close-banner title="关闭提示">稍后</button>
        </span>
    `;
    banner.classList.remove('hidden');
    const close = banner.querySelector('[data-close-banner]');
    if (close) close.addEventListener('click', () => banner.classList.add('hidden'));
}

async function saveOnboarding(action) {
    return jsonFetch('/api/onboarding/status', {
        method: 'POST',
        body: JSON.stringify({ action })
    });
}

function renderOnboarding(root, status, hasModels) {
    if (!root || status.completed || status.skipped) {
        if (root) root.classList.add('hidden');
        return;
    }
    root.innerHTML = `
        <b>新手三步走</b>
        <div class="onboarding-steps">
            <article class="onboarding-step">
                <b>第 1 步 · 检查运行环境</b>
                <p>先确认 Node、博途 Openness、在线引擎和密钥都正常。</p>
                <a class="tia-btn is-ghost is-sm" href="env-check.html" data-onboarding-env>立即检查</a>
            </article>
            <article class="onboarding-step">
                <b>第 2 步 · 配置 AI 大模型</b>
                <p>${hasModels ? '已检测到可用模型，可以继续。' : '粘贴 API Key、获取模型列表并启用默认模型。'}</p>
                <a class="tia-btn is-ghost is-sm" href="settings.html" data-onboarding-settings>去配置</a>
                <div class="ai-quick-setup" style="${hasModels ? 'display:none' : 'display:grid;gap:6px;margin-top:8px'}">
                    <select data-ai-preset title="选择常见供应商">${presetOptions()}</select>
                    <input data-ai-base type="text" placeholder="Base URL" style="width:100%">
                    <input data-ai-key type="password" placeholder="粘贴 API Key" autocomplete="off" style="width:100%">
                    <button class="tia-btn is-primary is-sm" type="button" data-ai-save>测试并启用默认模型</button>
                    <small data-ai-status></small>
                </div>
            </article>
            <article class="onboarding-step">
                <b>第 3 步 · 连接博途</b>
                <p>不连接也能生成代码；连接后可以读取工程并一键写入。</p>
                <button class="tia-btn is-ghost is-sm" type="button" data-onboarding-connect>连接博途</button>
            </article>
        </div>
        <div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end">
            <button class="tia-btn is-ghost is-sm" type="button" data-onboarding-skip>跳过</button>
            <button class="tia-btn is-primary is-sm" type="button" data-onboarding-complete>完成向导</button>
        </div>
    `;
    root.classList.remove('hidden');
    const connect = root.querySelector('[data-onboarding-connect]');
    if (connect) connect.addEventListener('click', () => {
        const btn = document.getElementById('btnTiaOnline');
        if (btn) btn.click();
    });
    const skip = root.querySelector('[data-onboarding-skip]');
    if (skip) skip.addEventListener('click', async () => {
        await saveOnboarding('skip');
        root.classList.add('hidden');
    });
    const complete = root.querySelector('[data-onboarding-complete]');
    if (complete) complete.addEventListener('click', async () => {
        await saveOnboarding('complete');
        root.classList.add('hidden');
    });
    bindAiQuickSetup(root, () => renderBanner(true));
}

async function hasAvailableModels() {
    try {
        const models = await jsonFetch('/api/models');
        return !!(models.success && Array.isArray(models.models) && models.models.length);
    } catch {
        return false;
    }
}

function renderTiaErrorActionTemplate() {
    return TIA_ERROR_ACTIONS.map(label => `<button type="button">${esc(label)}</button>`).join('');
}

async function bootOnboarding() {
    if (!token()) return;
    const root = document.getElementById('onboardingRoot');
    const [scenarios, hasModels, statusBody] = await Promise.all([
        loadScenarios().catch(() => []),
        hasAvailableModels(),
        jsonFetch('/api/onboarding/status').catch(() => ({ onboarding: { completed: false, skipped: false } }))
    ]);
    if (scenarios.length) renderWelcome(scenarios);
    renderBanner(hasModels);
    renderOnboarding(root, statusBody.onboarding || {}, hasModels);
    window.renderOnboardingWelcome = () => renderWelcome(scenarios);
    window.renderTiaErrorActionTemplate = renderTiaErrorActionTemplate;
}

document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => { bootOnboarding().catch(console.error); }, 150);
});

export { renderWelcome, renderTiaErrorActionTemplate };
