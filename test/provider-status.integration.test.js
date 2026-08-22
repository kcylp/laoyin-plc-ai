// 接口级集成测试：本地 mock provider 验证测试状态全链路（passed/failed 真实网络路径）。
// 不依赖真实 API Key；被测服务使用临时数据库 + 随机端口，测试后清理。
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');

// ---- 本地 mock 供应商：GET /models + POST /chat/completions ----
function startMockProvider({ chatStatus = 200, modelsStatus = 200 } = {}) {
    const state = { chatStatus, modelsStatus, chatHits: 0, modelsHits: 0 };
    const server = http.createServer((req, res) => {
        const send = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        if (req.method === 'GET' && /\/models$/.test(req.url)) {
            state.modelsHits++;
            if (state.modelsStatus >= 400) return send(state.modelsStatus, { error: { message: 'mock models denied' } });
            return send(200, {
                data: [
                    { id: 'mock-model-a', display_name: 'Mock A' },
                    { id: 'mock-model-b', display_name: 'Mock B' }
                ]
            });
        }
        if (req.method === 'POST' && /\/chat\/completions$/.test(req.url)) {
            state.chatHits++;
            if (state.chatStatus >= 400) return send(state.chatStatus, { error: { message: 'mock chat denied' } });
            return send(200, { choices: [{ message: { content: 'OK' } }] });
        }
        send(404, { error: { message: 'not found' } });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            state.port = server.address().port;
            state.close = () => new Promise(r => server.close(r));
            resolve(state);
        });
    });
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = http.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const p = srv.address().port;
            srv.close(() => resolve(p));
        });
    });
}

function startAppServer(dbPath, port) {
    const child = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: { ...process.env, PORT: String(port), DB_PATH: dbPath },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', d => (log += d));
    child.stderr.on('data', d => (log += d));
    return { child, getLog: () => log };
}

async function waitReady(base, getLog, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(base + '/login.html');
            if (r.ok) return;
        } catch (e) { /* not up yet */ }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('被测服务未就绪。日志：' + getLog());
}

async function api(base, token, method, urlPath, body) {
    const r = await fetch(base + urlPath, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: 'Bearer ' + token } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    const j = await r.json().catch(() => ({}));
    j.httpStatus = r.status;
    return j;
}

function dbGet(dbPath, sql, ...args) {
    const db = new DatabaseSync(dbPath);
    try {
        return db.prepare(sql).get(...args);
    } finally {
        db.close();
    }
}

function dbAll(dbPath, sql, ...args) {
    const db = new DatabaseSync(dbPath);
    try {
        return db.prepare(sql).all(...args);
    } finally {
        db.close();
    }
}

// 启动一套独立环境（mock + 被测服务 + 临时 DB），返回公共工具
async function setupEnv(t, options = {}) {
    const mock = await startMockProvider(options);
    const dbPath = path.join(os.tmpdir(), `plc-status-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    const port = await freePort();
    const app = startAppServer(dbPath, port);
    const base = `http://127.0.0.1:${port}`;
    t.after(async () => {
        // Windows 上子进程退出前 SQLite 句柄未释放，先等 exit 再删临时库
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, 800);
            app.child.once('exit', () => { clearTimeout(timer); resolve(); });
            app.child.kill();
        });
        await mock.close();
        try { fs.rmSync(dbPath, { force: true }); } catch (e) { /* 句柄偶发占用，忽略 */ }
    });
    await waitReady(base, () => app.getLog());

    const username = 'mocktest_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const reg = await api(base, null, 'POST', '/api/register', { username, password: 'test123456' });
    assert.equal(reg.success, true, '注册应成功');
    const login = await api(base, null, 'POST', '/api/login', { username, password: 'test123456' });
    assert.ok(login.token, '登录应返回 token');
    return { base, token: login.token, mock, dbPath, username };
}

async function createProvider(base, token, mockPort) {
    const prov = await api(base, token, 'POST', '/api/ai/providers', {
        name: 'Mock Provider',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'sk-mock',
        wire_api: 'openai'
    });
    assert.equal(prov.success, true, '创建供应商应成功');
    return prov.id;
}

const MODELS = [
    { id: 'mock-model-a', label: 'Mock A' },
    { id: 'mock-model-b', label: 'Mock B' }
];

test('绿灯链路：mock 全 200 → passed；切到未测试模型必须 unknown（模型级状态）', async (t) => {
    const { base, token, mock, dbPath } = await setupEnv(t);
    const pid = await createProvider(base, token, mock.port);

    // 新供应商默认 unknown
    let list = await api(base, token, 'GET', '/api/ai/providers');
    assert.equal(list.providers[0].testStatus, 'unknown');

    // 测试接口：列表 + 聊天探测都成功 → passed
    const testRes = await api(base, token, 'POST', `/api/ai/providers/${pid}/test`);
    assert.equal(testRes.success, true);
    assert.equal(testRes.testStatus, 'passed');
    assert.equal(testRes.count, 2);
    assert.equal(testRes.testMessage, '');
    assert.ok(mock.chatHits >= 1, '应真实调用过聊天探测');
    assert.equal(dbGet(dbPath, 'SELECT test_status s FROM ai_providers WHERE id = ?', pid).s, 'passed');

    // 保存两个模型：模型 A（首选）= passed，模型 B = unknown
    const save = await api(base, token, 'POST', `/api/ai/providers/${pid}/models`, { models: MODELS });
    assert.equal(save.success, true);
    assert.equal(save.testStatus, 'passed');
    const rows = dbAll(dbPath, 'SELECT model_id, test_status FROM ai_models WHERE provider_id = ? ORDER BY id', pid);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].model_id, 'mock-model-a');
    assert.equal(rows[0].test_status, 'passed', '首选模型必须 passed');
    assert.equal(rows[1].model_id, 'mock-model-b');
    assert.equal(rows[1].test_status, 'unknown', '未测试模型必须 unknown，不能继承绿色');

    // 主界面：当前模型 A → passed
    let wb = await api(base, token, 'GET', '/api/workbench/status');
    assert.ok(wb.status, 'workbench 应返回 status');
    assert.equal(wb.status.ai.currentModelId, `db${pid}/mock-model-a`);
    assert.equal(wb.status.ai.currentModelTestStatus, 'passed');
    assert.equal(wb.status.ai.currentModelTestMessage, '');

    // 核心：切换到模型 B → 必须 unknown（不能因为供应商/模型 A 是 passed 就误绿）
    const sw = await api(base, token, 'POST', '/api/models/current', { modelId: `db${pid}/mock-model-b` });
    assert.equal(sw.success, true);
    wb = await api(base, token, 'GET', '/api/workbench/status');
    assert.equal(wb.status.ai.currentModelId, `db${pid}/mock-model-b`);
    assert.equal(wb.status.ai.currentModelTestStatus, 'unknown', '切换未测试模型后必须显示未测试');

    // 切回 A → 状态保留 passed（刷新/切换后持久化）
    await api(base, token, 'POST', '/api/models/current', { modelId: `db${pid}/mock-model-a` });
    wb = await api(base, token, 'GET', '/api/workbench/status');
    assert.equal(wb.status.ai.currentModelTestStatus, 'passed', '切回已测试模型应恢复 passed');

    // 设置页列表：模型数组带模型级状态
    list = await api(base, token, 'GET', '/api/ai/providers');
    const models = list.providers[0].models;
    assert.equal(models.length, 2);
    assert.equal(models[0].model_id, 'mock-model-a');
    assert.equal(models[0].test_status, 'passed');
    assert.equal(models[1].model_id, 'mock-model-b');
    assert.equal(models[1].test_status, 'unknown');
});

test('红灯链路：聊天通道 401 → failed 落库；主界面/设置页均为 failed', async (t) => {
    const { base, token, mock, dbPath } = await setupEnv(t, { chatStatus: 401 });
    const pid = await createProvider(base, token, mock.port);

    // 测试接口：列表可读（2 个模型），但聊天探测 401 → 列表仍返回、状态 failed
    const testRes = await api(base, token, 'POST', `/api/ai/providers/${pid}/test`);
    assert.equal(testRes.success, true, '模型列表已读到，接口仍应 success（保留预览）');
    assert.equal(testRes.testStatus, 'failed', '聊天探测失败必须 failed，不能 passed');
    assert.equal(testRes.count, 2);
    assert.ok(testRes.testMessage.includes('mock chat denied'), 'testMessage 应包含具体原因');
    assert.ok(mock.chatHits >= 1, '应真实调用过聊天探测');
    assert.equal(dbGet(dbPath, 'SELECT test_status s FROM ai_providers WHERE id = ?', pid).s, 'failed');

    // 保存模型：probe 失败 → 保存成功但 testStatus failed（模型保存 ≠ 测试通过）
    const save = await api(base, token, 'POST', `/api/ai/providers/${pid}/models`, { models: MODELS });
    assert.equal(save.success, true);
    assert.equal(save.testStatus, 'failed');
    const first = dbGet(dbPath, 'SELECT model_id, test_status FROM ai_models WHERE provider_id = ? ORDER BY id LIMIT 1', pid);
    assert.equal(first.test_status, 'failed', '首选模型必须 failed');

    // 主界面：当前模型 → failed（红灯）
    const wb = await api(base, token, 'GET', '/api/workbench/status');
    assert.equal(wb.status.ai.currentModelTestStatus, 'failed');
    assert.ok(wb.status.ai.currentModelTestMessage.includes('mock chat denied'));
});

test('列表失败链路：/models 500 → 接口失败 + failed，绝不 passed', async (t) => {
    const { base, token, mock, dbPath } = await setupEnv(t, { modelsStatus: 500 });
    const pid = await createProvider(base, token, mock.port);

    const testRes = await api(base, token, 'POST', `/api/ai/providers/${pid}/test`);
    assert.equal(testRes.success, false);
    assert.equal(testRes.testStatus, 'failed');
    assert.ok(testRes.message, '应有失败原因');
    assert.equal(dbGet(dbPath, 'SELECT test_status s FROM ai_providers WHERE id = ?', pid).s, 'failed');
    assert.equal(mock.chatHits, 0, '列表失败不应继续探测聊天');
});
