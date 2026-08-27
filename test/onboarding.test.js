const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');

function read(file) {
    return fs.readFileSync(path.join(root, file), 'utf8');
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
        env: {
            ...process.env,
            NODE_TEST_CONTEXT: '1',
            NODE_TEST_WORKER_ID: process.env.NODE_TEST_WORKER_ID || '1',
            PORT: String(port),
            DB_PATH: dbPath,
            TIA_PREWARM: '0'
        },
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
        } catch {
            // not up yet
        }
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

async function setupEnv(t) {
    const dbPath = path.join(os.tmpdir(), `plc-onboarding-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    const port = await freePort();
    const app = startAppServer(dbPath, port);
    const base = `http://127.0.0.1:${port}`;
    t.after(async () => {
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, 800);
            app.child.once('exit', () => { clearTimeout(timer); resolve(); });
            app.child.kill();
        });
        try { fs.rmSync(dbPath, { force: true }); } catch { /* ignore */ }
    });
    await waitReady(base, () => app.getLog());
    return { base, dbPath };
}

async function registerAndLogin(base, suffix) {
    const username = 'onboard_' + suffix + '_' + Math.random().toString(36).slice(2, 7);
    const password = 'test123456';
    const reg = await api(base, null, 'POST', '/api/register', { username, password });
    assert.equal(reg.success, true, '注册应成功');
    const login = await api(base, null, 'POST', '/api/login', { username, password });
    assert.ok(login.token, '登录应返回 token');
    assert.ok(login.user.id, '登录应返回 user id');
    return { token: login.token, userId: login.user.id };
}

function dbGet(dbPath, sql, ...args) {
    const db = new DatabaseSync(dbPath);
    try {
        return db.prepare(sql).get(...args);
    } finally {
        db.close();
    }
}

test('onboarding status is persisted in user_settings and isolated per user', async (t) => {
    const { base, dbPath } = await setupEnv(t);
    const a = await registerAndLogin(base, 'a');
    const b = await registerAndLogin(base, 'b');

    const columns = dbGet(dbPath, "SELECT COUNT(*) AS c FROM pragma_table_info('user_settings') WHERE name IN ('onboarding_completed', 'onboarding_skipped')");
    assert.equal(columns.c, 2, 'user_settings 必须具备两个 onboarding 列');

    const anonymous = await api(base, null, 'GET', '/api/onboarding/status');
    assert.equal(anonymous.httpStatus, 401, '匿名读取必须拒绝');

    let statusA = await api(base, a.token, 'GET', '/api/onboarding/status');
    assert.equal(statusA.success, true);
    assert.equal(statusA.onboarding.completed, false);
    assert.equal(statusA.onboarding.skipped, false);

    const db = new DatabaseSync(dbPath);
    try {
        db.prepare('INSERT INTO user_settings (user_id, current_model_id, updated_at) VALUES (?, ?, datetime(\'now\',\'localtime\')) ON CONFLICT(user_id) DO UPDATE SET current_model_id = excluded.current_model_id').run(a.userId, 'db99/mock-model');
    } finally {
        db.close();
    }

    const complete = await api(base, a.token, 'POST', '/api/onboarding/status', { action: 'complete' });
    assert.equal(complete.success, true);
    assert.equal(complete.onboarding.completed, true);
    assert.equal(complete.onboarding.skipped, false);
    assert.equal(dbGet(dbPath, 'SELECT current_model_id FROM user_settings WHERE user_id = ?', a.userId).current_model_id, 'db99/mock-model', '写 onboarding 不得覆盖当前模型');

    const statusB = await api(base, b.token, 'GET', '/api/onboarding/status');
    assert.equal(statusB.onboarding.completed, false, '用户 B 不得读到用户 A 的完成状态');
    assert.equal(statusB.onboarding.skipped, false);

    const skipB = await api(base, b.token, 'POST', '/api/onboarding/status', { action: 'skip' });
    assert.equal(skipB.onboarding.completed, false);
    assert.equal(skipB.onboarding.skipped, true);

    const resetA = await api(base, a.token, 'POST', '/api/onboarding/status', { action: 'reset' });
    assert.equal(resetA.onboarding.completed, false);
    assert.equal(resetA.onboarding.skipped, false);
});

test('scenario cards use knowledge index as the single JSON source with twelve editable PLC prompts', () => {
    const { createKnowledgeService } = require('../lib/knowledge');
    const scenarios = createKnowledgeService().getScenarioCards(12);
    assert.equal(scenarios.length, 12, '必须提供 12 张场景卡');
    const titles = scenarios.map(s => s.title);
    assert.deepEqual(titles.slice(0, 8), [
        '电机起保停（自锁）', '起保停（置位复位版）', '正反转互锁', '点动与长动切换',
        '手动/自动方式切换', '上升沿触发一次', '闪烁/报警灯', '通电延时 / 断电延时'
    ]);
    assert.ok(titles.includes('多台设备轮换'), '入门条目不足 12 张时应从同一 index 顺序补足常用场景');
    for (const item of scenarios) {
        assert.match(item.id, /^[a-z0-9-]+$/);
        assert.ok(item.prompt.length >= 18, `${item.title} prompt 应是可直接填入输入框的需求描述`);
        assert.doesNotMatch(item.prompt, /<[^>]+>/, '场景文案不得带 HTML');
        assert.equal(item.source, 'knowledge/index.json');
    }
    assert.match(createKnowledgeService().getScenarioCards(32).find(s => s.id === 'multi-pump-rotate').prompt, /轮换/);
});

test('workbench loads onboarding, removes frontend keyword hard-stop, and exposes newbie guidance hooks', () => {
    const index = read('index.html');
    const chat = read('web/chat.js');
    const onboarding = read('web/onboarding.js');
    const tree = read('web/tree.js');
    const settings = read('settings.html');
    const env = read('env-check.html');

    assert.match(index, /id="onboardingBanner"/);
    assert.match(index, /id="onboardingRoot"/);
    assert.match(index, /src="web\/onboarding\.js"/);
    assert.match(index, /id="shortcutHelpModal"/);

    assert.doesNotMatch(chat, /isPLCRelated/);
    assert.doesNotMatch(chat, /抱歉，我是专业的PLC编程助手，专注于/);

    assert.match(onboarding, /jsonFetch\('\/api\/knowledge\/scenarios'/);
    assert.doesNotMatch(onboarding, /fetch\('web\/scenarios\.json'/);
    assert.match(onboarding, /\/api\/onboarding\/status/);
    assert.match(onboarding, /renderWelcome/);
    assert.match(onboarding, /data-scenario-id/);
    assert.match(onboarding, /AI_PROVIDER_PRESETS/);
    assert.match(onboarding, /DeepSeek/);
    assert.match(onboarding, /\/api\/ai\/providers/);
    assert.match(onboarding, /\/test/);
    assert.match(onboarding, /\/models/);
    assert.match(onboarding, /运行环境诊断/);
    assert.match(onboarding, /导出诊断包/);
    assert.match(onboarding, /重新生成/);

    assert.match(tree, /未连接博途/);
    assert.match(tree, /btnTiaOnline/);
    assert.doesNotMatch(tree, /wrap\.classList\.add\('hidden'\)/);

    assert.match(settings, /id="rerunOnboardingBtn"/);
    assert.match(settings, /action:\s*'reset'/);
    assert.match(env, /data-onboarding-next/);
});

test('confirm dialog and workbench shortcuts are keyboard reachable', () => {
    const confirm = read('web/confirm-dialog.js');
    const statusbar = read('web/statusbar.js');
    const index = read('index.html');

    assert.match(confirm, /keydown/);
    assert.match(confirm, /event\.key === 'Escape'/);
    assert.match(confirm, /focusable/);
    assert.match(confirm, /confirmCancel[\s\S]*focus\(\)/);

    assert.match(statusbar, /event\.key === 'Enter' && !event\.shiftKey/);
    assert.match(statusbar, /ctrlKey[\s\S]*key\.toLowerCase\(\) === 'k'/);
    assert.match(statusbar, /key === 'F1'/);
    assert.match(statusbar, /ctrlKey[\s\S]*\/'/);
    assert.match(index, /id="shortcutHelpModal"/);
    assert.match(index, /title="打开设置"/);
    assert.match(index, /title="打开环境自检"/);
});
