const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { readBackendFile, readBackendSource } = require('./helpers/backend-source');

const root = path.resolve(__dirname, '..');
const backendSrc = readBackendSource();
const serverEntrySrc = readBackendFile('server.js');

function read(file) {
    return fs.readFileSync(path.join(root, file), 'utf8');
}

function readClientBundle() {
    return [
        'web/app.js',
        'web/api.js',
        'web/chat.js',
        'web/confirm-dialog.js',
        'web/code-blocks.js',
        'web/history.js',
        'web/inspector.js',
        'web/online.js',
        'web/output-panel.js',
        'web/statusbar.js',
        'web/tia-actions.js',
        'web/tree.js',
    ].map(read).join('\n');
}

function readCssBundle() {
    return [
        'web/css/tokens.css',
        'web/css/shell.css',
        'web/css/chat.css',
        'web/css/panels.css',
        'web/css/modals.css',
        'web/css/components.css',
    ].map(read).join('\n');
}

test('login page keeps auth hooks inside the PLC console shell', () => {
    const html = read('login.html');
    const css = read('login.css');

    for (const id of [
        'loginForm',
        'registerForm',
        'loginFormElement',
        'registerFormElement',
        'loginUsername',
        'loginPassword',
        'registerUsername',
        'registerPassword',
        'confirmPassword',
        'email',
        'loginBtnText',
        'loginLoader',
        'registerBtnText',
        'registerLoader',
        'message',
    ]) {
        assert.match(html, new RegExp(`id="${id}"`));
    }

    assert.match(html, /class="login-console[^"]*tia-portal-shell/);
    assert.match(html, /class="signal-grid"/);
    assert.match(html, /class="auth-panel"/);
    assert.match(css, /@import url\("tia\.css"\)/);
    assert.match(css, /var\(--tia-panel\)/);
    assert.doesNotMatch(css, /#06110f|#2ef2c1/i);
});

test('workbench page exposes the three-column engineering shell', () => {
    const html = read('index.html');
    assert.match(html, /class="tia-portal-shell"/);
    assert.match(html, /id="projectTree"/);
    assert.match(html, /class="tia-canvas"/);
    assert.match(html, /id="inspector"/);
    assert.match(html, /id="stElapsed"/);
    assert.match(html, /class="tia-output collapsed" id="outputPanel"/);
    assert.match(html, /class="tia-fullpanel hidden" id="onlinePanel"/);
    assert.match(html, /class="tia-modal-mask hidden" id="confirmModal"/);
    assert.match(html, /id="confirmFacts"/);
    assert.match(html, /id="confirmRequiredCheck"/);
    assert.doesNotMatch(html, /id="tiaOnlineDrawer"/);
    assert.doesNotMatch(html, /id="dlModal"/);
    assert.doesNotMatch(html, /id="odResultWrap"/);
    assert.match(html, /data-lang="graph"/);
    assert.match(read('settings.html'), /class="settings-console[^"]*tia-portal-shell/);
    assert.match(read('env-check.html'), /class="env-console[^"]*tia-portal-shell/);
});

test('shared TIA design system supplies the prescribed palette and component primitives', () => {
    const css = readCssBundle();

    for (const token of [
        '--tia-titlebar: #27344f',
        '--tia-titlebar-text: #ffffff',
        '--tia-titlebar-muted: rgba(255, 255, 255, .82)',
        '--tia-ribbon: #eceff1',
        '--tia-accent: #1f6feb',
        '--tia-ok: #1858c4',
        '--tia-titlebar-h: 34px',
        '--tia-ribbon-h: 40px',
        '--tia-status-h: 26px',
    ]) {
        assert.ok(css.includes(token), `missing design token: ${token}`);
    }

    for (const selector of [
        '.tia-shell', '.tia-titlebar', '.tia-ribbon', '.tia-body',
        '.tia-tree', '.tia-canvas', '.tia-inspector', '.tia-statusbar',
        '.tia-led', '.tia-btn', '.tia-field', '.tia-table', '.tia-tabs',
        '.tia-modal', '.tia-badge', '.tia-code', '.tia-empty', '.tia-output',
        '.tia-fullpanel', '.confirm-facts', '.output-row', '.tia-insp-breadcrumb',
    ]) {
        assert.ok(css.includes(selector), `missing component primitive: ${selector}`);
    }

    assert.match(css, /border-radius: var\(--tia-radius\)/);
    assert.match(css, /transition: background-color 120ms ease/);
});

test('assistant code blocks stay bounded and scroll instead of expanding the page', () => {
    const css = readCssBundle();
    const codeBlockRule = css.match(/\.tia-code pre,\s*\.code-block pre\s*\{[\s\S]*?\}/)?.[0] || '';

    assert.match(codeBlockRule, /overflow:\s*auto/);
    assert.match(codeBlockRule, /max-height:\s*min\(52vh, 560px\)/);
    assert.match(codeBlockRule, /scrollbar-gutter:\s*stable/);
});

test('every page header uses the shared high-contrast TIA blue treatment', () => {
    const tia = readCssBundle();
    const operations = read('operations.css');
    const admin = read('admin.css');
    const upgrade = read('upgrade.css');
    const login = read('login.css');
    const settings = read('settings.html');

    assert.match(tia, /\.tia-titlebar[\s\S]*background: var\(--tia-titlebar\)/);
    assert.match(tia, /\.tia-titlebar[\s\S]*color: var\(--tia-titlebar-text\)/);
    assert.match(operations, /body\.settings-console \.header,[\s\S]*background: var\(--tia-titlebar\)/);
    assert.match(operations, /\.header h1[\s\S]*color: var\(--tia-titlebar-text\)[\s\S]*font: 700/);
    assert.match(admin, /\.header[\s\S]*background: var\(--tia-titlebar\)/);
    assert.match(upgrade, /\.header[\s\S]*background: var\(--tia-titlebar\)/);
    assert.match(login, /\.auth-header[\s\S]*background: var\(--tia-titlebar\)/);
    const settingsHeaderBlock = settings.match(/\.settings-header\s*\{[\s\S]*?\}/)?.[0] || '';
    assert.match(settingsHeaderBlock, /background:\s*var\(--tia-titlebar\)/);
    assert.doesNotMatch(settingsHeaderBlock, /background:\s*#126b68/);
});

test('workbench status endpoint remains read-only and client loads it silently', () => {
    const client = readClientBundle();
    const statusRoute = backendSrc.match(/router\.get\('\/workbench\/status'[\s\S]*?\n\}\);/)?.[0] || '';

    assert.match(client, /async loadWorkbenchStatus\(\)/);
    assert.match(client, /fetch\('\/api\/workbench\/status'/);
    assert.match(client, /inspectorShow\('system'/);
    assert.match(statusRoute, /SELECT COUNT\(\*\) c FROM ai_providers WHERE user_id = \?/);
    assert.match(statusRoute, /runtime: \{ node: process\.version \}/);
    assert.doesNotMatch(statusRoute, /checkOpennessEnvironment|preflightImport|importToTia|llmStream|execFile/);
});

test('frontend assets are served without stale browser cache during field testing', () => {
    assert.match(serverEntrySrc, /NO_STORE_STATIC_EXTENSIONS = new Set\(\['\.html', '\.js', '\.css'\]\)/);
    assert.match(serverEntrySrc, /setHeaders\(res, filePath\)/);
    assert.match(serverEntrySrc, /X-Content-Type-Options', 'nosniff'/);
    assert.match(serverEntrySrc, /Cache-Control', 'no-store, max-age=0, must-revalidate'/);
    assert.match(serverEntrySrc, /Pragma', 'no-cache'/);
    assert.match(serverEntrySrc, /Expires', '0'/);
});

test('settings tests saved providers on the backend and workbench persists fallback model', () => {
    const settings = read('settings.html');
    const client = readClientBundle();

    assert.match(settings, /api\('\/api\/ai\/providers\/' \+ id \+ '\/test'/);
    assert.doesNotMatch(settings, /function testProvider[\s\S]*?\/api\/ai\/providers\/' \+ id \+ '\/key'[\s\S]*?\/api\/ai\/fetch-models/);
    assert.match(backendSrc, /router\.post\('\/providers\/:id\/test'/);
    assert.match(backendSrc, /fetchModelList\(existing\.base_url, key, existing\.wire_api\)/);
    assert.match(client, /localStorage\.setItem\('plcModel', this\.modelId\)/);
});

test('settings does not reuse a stale provider id after provider fields change', () => {
    const settings = read('settings.html');

    assert.match(settings, /let providerFormDirty = false/);
    assert.match(settings, /\['pName', 'pUrl', 'pWire', 'pKey'\][\s\S]*providerFormDirty = true/);
    assert.match(settings, /async function saveCurrentProvider/);
    assert.match(settings, /const explicitProviderId = options\.providerId/);
    assert.match(settings, /if \(!pid \|\| \(!explicitProviderId && providerFormDirty\)\)/);
    assert.match(settings, /r\.status === 404[\s\S]*saveCurrentProvider/);
});

test('settings helper bundle does not collide with the page api function', () => {
    const helpers = read('ai-models.js');
    const settings = read('settings.html');

    assert.match(settings, /async function api\(/);
    assert.doesNotMatch(helpers, /\bconst\s+api\s*=/);
});

test('settings model save cannot silently clear models and provider save persists checked preview models', () => {
    const settings = read('settings.html');

    assert.match(settings, /async function saveSelectedModelsFromPreview/);
    assert.match(settings, /function renderModelPreview\(/);
    assert.match(settings, /\$\('saveBtn'\)\.onclick[\s\S]*saveSelectedModelsFromPreview/);
    assert.match(settings, /function testProvider[\s\S]*renderModelPreview\(j\.models/);
    assert.match(settings, /providerId:\s*id/);
    assert.match(settings, /AiModels\.getInitialModelId\(/);
    assert.match(settings, /请至少勾选一个模型/);
    assert.match(backendSrc, /if \(!models\.length\)[\s\S]*请至少选择一个模型/);
});

test('model save persists selections even when chat probe only returns a channel warning', () => {
    const settings = read('settings.html');
    const saveRoute = backendSrc.match(/router\.post\('\/providers\/:id\/models'[\s\S]*?\n\}\);/)?.[0] || '';

    assert.match(saveRoute, /const probeWarning = probe\.ok \? '' : probe\.message/);
    assert.doesNotMatch(saveRoute, /if \(!probe\.ok\)[\s\S]*?return res\.status\(400\)/);
    // 响应保留 success/count/currentModelId/probeWarning，并追加 testStatus/testMessage
    assert.match(saveRoute, /res\.json\(\{ success: true, count: models\.length, currentModelId:[\s\S]*probeWarning/);
    assert.match(saveRoute, /testStatus: probe\.ok \? 'passed' : 'failed'/);
    assert.match(settings, /r\.probeWarning/);
});

test('workbench uses the backend current model and persists dropdown changes', () => {
    const client = readClientBundle();

    assert.match(backendSrc, /function getCurrentModel\(userId, models\)/);
    assert.match(backendSrc, /CREATE TABLE IF NOT EXISTS user_settings/);
    assert.match(backendSrc, /router\.post\('\/models\/current'/);
    assert.match(backendSrc, /currentModelId: currentModel\.id/);
    assert.match(client, /const preferred = data\.currentModelId[\s\S]*?\? data\.currentModelId[\s\S]*?: null/);
    assert.doesNotMatch(client, /const saved = localStorage\.getItem\('plcModel'\)/);
    assert.match(client, /async persistCurrentModel\(modelId\)/);
    assert.match(client, /fetch\('\/api\/models\/current'/);
});

test('workbench refreshes the inspector after model load and dropdown persistence', () => {
    const client = readClientBundle();
    const loadModels = client.match(/async loadModels\(\) \{[\s\S]*?\n    async persistCurrentModel/)?.[0] || '';
    const persistCurrentModel = client.match(/async persistCurrentModel\(modelId\) \{[\s\S]*?\n    async loadWorkbenchStatus/)?.[0] || '';

    assert.match(loadModels, /await this\.loadWorkbenchStatus\(\)/);
    assert.match(persistCurrentModel, /await this\.loadWorkbenchStatus\(\)/);
    assert.match(persistCurrentModel, /this\.modelSelect\.value = data\.currentModelId/);
});

test('settings page marks the backend current model and stores the authoritative saved id', () => {
    const settings = read('settings.html');
    const providerRoute = backendSrc.match(/router\.get\('\/providers'[\s\S]*?\n\}\);/)?.[0] || '';

    assert.match(providerRoute, /const currentModel = getCurrentModel\(req\.user\.id\)/);
    assert.match(providerRoute, /currentModelId: currentModel\.id/);
    assert.match(settings, /let currentModelId = ''/);
    assert.match(settings, /function modelTag\(m, providerId\)/);
    assert.match(settings, /tag-current/);
    assert.match(settings, /r\.currentModelId/);
    assert.match(settings, /localStorage\.setItem\('plcModel', r\.currentModelId\)/);
});

test('legacy stylesheet no longer paints send-to-tia controls green', () => {
    const css = read('style.css');
    const sendTia = css.match(/\.code-action\.send-tia\s*\{[\s\S]*?\}/)?.[0] || '';

    assert.doesNotMatch(sendTia, /#0f5f52|#14806d|#16a34a/i);
    assert.match(sendTia, /#1f6feb|#27344f|#1858c4/);
});

test('success states use TIA blue instead of green across the shell', () => {
    const tia = readCssBundle();
    const operations = read('operations.css');
    const legacy = read('style.css');
    // tia.css 单独保留：其 #16a34a 仅用于模型测试状态灯（.tia-model-test-led.is-pass），
    // 属“测试通过”语义而非通用成功色，不影响通用 UI 的蓝色成功规范。
    const corpus = [operations, legacy, backendSrc].join('\n');

    assert.match(tia, /--tia-ok: #1858c4/);
    assert.match(legacy, /\.validate-result\.valid\s*\{[\s\S]*background: #e8f1fe;[\s\S]*color: #1858c4;[\s\S]*\}/);
    assert.match(legacy, /body\.workbench-console \.validate-result\.valid\s*\{[\s\S]*background: #e8f1fe;[\s\S]*color: #1858c4;[\s\S]*\}/);
    assert.match(legacy, /\.modal-result\.valid\s*\{[\s\S]*border: 1px solid #a9c9f7;[\s\S]*color: #1858c4;[\s\S]*\}/);
    assert.doesNotMatch(corpus, /#16a34a|#123322|#a8ffc8|#2e9e5b|#14532d|#bbf7d0|#1e7f45|#b8e1c5|#eef8f1|#dcfce7/i);
});

test('model test status: server persistence, settings lamps, workbench indicator', () => {
    const index = read('index.html');
    const client = readClientBundle();
    const settings = read('settings.html');

    // 主界面：模型下拉框后紧跟测试状态节点（不在右侧按钮区）
    assert.match(index, /<select id="modelSelect"[^>]*>[\s\S]*?<\/select>\s*<span id="modelTestStatus"/);
    assert.match(index, /class="tia-model-test-status"/);
    assert.match(index, /tia-model-test-led is-idle/);

    // script.js：统一渲染函数，状态只来自服务端 /api/workbench/status
    assert.match(client, /updateModelTestStatus\(status, message = ''\)/);
    assert.match(client, /currentModelTestStatus/);
    assert.match(client, /j\.status\.ai\.currentModelTestStatus/);
    assert.match(client, /this\.modelTestStatus = document\.getElementById\('modelTestStatus'\)/);
    // 只检查 updateModelTestStatus 函数体内部不使用 localStorage（截取函数体，避免跨函数误报）
    const updateFn = client.match(/updateModelTestStatus\(status, message = ''\) \{\n([\s\S]*?)\n    \}/)?.[0] || '';
    assert.ok(updateFn.includes('updateModelTestStatus'), 'updateModelTestStatus 函数未找到');
    assert.doesNotMatch(updateFn, /localStorage/);

    // 设置页：带文字的状态结构 + 统一状态函数 + 绿/红独立类
    assert.match(settings, /pc-test-state" id="test-state-/);
    assert.match(settings, /function setProviderTestState/);
    assert.match(settings, /测试通过/);
    assert.match(settings, /测试未通过/);
    assert.match(settings, /\.pc-status\.pass \{ background: #16a34a/);
    assert.match(settings, /\.pc-status\.fail \{ background: #dc2626/);
    assert.match(settings, /providerTestState\(p\.testStatus\)/);

    // 服务端：三字段建表 + 兼容迁移 + 统一写入函数 + 列表返回驼峰 + 状态接口
    assert.match(backendSrc, /test_status TEXT NOT NULL DEFAULT 'unknown'/);
    assert.match(backendSrc, /PRAGMA table_info\(ai_providers\)/);
    assert.match(backendSrc, /ALTER TABLE ai_providers ADD COLUMN test_status/);
    assert.match(backendSrc, /function setProviderTestStatus\(providerId, status, message = ''\)/);
    assert.match(backendSrc, /testStatus: r\.test_status \|\| 'unknown'/);
    assert.match(backendSrc, /currentModelTestStatus/);
    assert.match(backendSrc, /setProviderTestStatus\(pid, 'failed'/);

    // 模型级状态：ai_models 三字段 + 迁移 + setModelTestStatus + 保存事务内写模型级 + workbench 查模型级
    assert.match(backendSrc, /CREATE TABLE IF NOT EXISTS ai_models[\s\S]*test_status TEXT NOT NULL DEFAULT 'unknown'/);
    assert.match(backendSrc, /PRAGMA table_info\(ai_models\)/);
    assert.match(backendSrc, /ALTER TABLE ai_models ADD COLUMN test_status/);
    assert.match(backendSrc, /function setModelTestStatus\(modelRowId, status, message = ''\)/);
    assert.match(backendSrc, /setModelTestStatus\(firstModelRowId, probeStatus, probeMsg\)/);
    assert.match(backendSrc, /SELECT am\.test_status[\s\S]*FROM ai_models am/);
    assert.match(backendSrc, /midMatch = mid\.match\(\/\^db\(\\d\+\)\\\/\(\[\\s\\S\]\+\)\$\/\)/);

    // 旧“列表可读=黄色成功”逻辑已删除：不再用 yellow/gray/ok 灯，不再有 status-${id}
    assert.doesNotMatch(settings, /pc-status yellow/);
    assert.doesNotMatch(settings, /pc-status\.ok \{/);
    assert.doesNotMatch(settings, /pc-status\.gray \{/);
    assert.doesNotMatch(settings, /id="status-/);
    assert.doesNotMatch(settings, /模型列表可读取；保存时验证聊天通道/);
    assert.doesNotMatch(settings, /\$\('status-' \+ id\)/);

    // 预览文案区分：列表失败 → 明确错误并隐藏预览；探测失败 → 保留预览 + “已读取”提示
    assert.match(settings, /模型列表读取失败[\s\S]*请检查 Base URL、协议和 API Key/);
    assert.match(settings, /模型列表已读取（' \+ j\.count \+ ' 个模型），但聊天通道测试未通过/);
    assert.match(settings, /fetchedModels = \[\];/);
    assert.doesNotMatch(settings, /renderModelPreview\(\[\], \{ providerId: id/);
});

test('secondary pages use the TIA Portal operations shell', () => {
    assert.match(read('admin.html'), /class="admin-console[^"]*tia-portal-shell/);
    assert.match(read('admin.css'), /TIA Admin Console/);
    assert.match(read('upgrade.html'), /class="upgrade-console[^"]*tia-portal-shell/);
    assert.match(read('upgrade.css'), /TIA Upgrade Console/);
});

test('settings and environment pages share the light operations stylesheet', () => {
    for (const page of ['settings.html', 'env-check.html']) {
        const html = read(page);
        assert.match(html, /href="operations\.css"/);
        assert.doesNotMatch(html, /href="style\.css"/);
    }

    const visibleUi = [read('login.html'), read('settings.html'), read('env-check.html')].join('\n');
    assert.doesNotMatch(visibleUi, /Eigen|CC Switch/i);
    assert.doesNotMatch(visibleUi, /#14605f|#1a7a7a|#126b68|#0f4f4d|#0f5b58|#9fc5c3|#eef7f6|#dcfce7|tag-green|pc-status\.green/i);
    assert.match(read('settings.html'), /const classes = \['tag'\]/);
    assert.match(read('settings.html'), /if \(isCurrent\) classes\.push\('tag-current'\)/);
});


test('left tree no longer duplicates ribbon series/language pickers', () => {
    const scriptSrc = readClientBundle();
    const treeSection = scriptSrc.slice(scriptSrc.indexOf('renderProjectTree()'), scriptSrc.indexOf('renderProjectTree()') + 2000);
    assert.ok(!treeSection.includes("folder('series'"));
    assert.ok(!treeSection.includes("folder('language'"));
    assert.ok(!treeSection.includes('data-tree-series'));
    assert.ok(!treeSection.includes('待写入队列'));
});

test('s200smart and graph are marked as to-be-developed and cannot be switched to', () => {
    const html = read('index.html');
    const scriptSrc = readClientBundle();
    assert.match(html, /data-series="s200smart"[^>]*>S7-200 SMART<span class="tab-todo">待开发<\/span>/);
    assert.match(html, /data-lang="graph"[^>]*>GRAPH<span class="tab-todo">待开发<\/span>/);
    assert.match(scriptSrc, /【S7-200 SMART】系列尚未开发/);
    assert.match(scriptSrc, /【GRAPH】语言尚未开发/);
    assert.match(scriptSrc, /if \(this\.series === 's200smart'\) this\.series = 's1200'/);
    const css = readCssBundle();
    assert.match(css, /\.tia-tab\.is-disabled/);
    assert.match(css, /\.tab-todo/);
});
