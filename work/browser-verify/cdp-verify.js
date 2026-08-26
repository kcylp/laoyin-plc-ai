// 浏览器最终验收（CDP headless Chrome）：执行人工复核清单并截图
// 用法: node cdp-verify.js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, 'verify-context.json'), 'utf8'));
const SHOT_DIR = __dirname;
fs.mkdirSync(SHOT_DIR, { recursive: true });

const results = {};
function record(key, ok, detail = '') { results[key] = { ok, detail }; }

// ---------- 最小 CDP 客户端 ----------
class CDP {
    constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.buf = ''; }
    static async connect(url) {
        const ws = new WebSocket(url);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        const c = new CDP(ws);
        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && c.pending.has(msg.id)) {
                const { res, rej } = c.pending.get(msg.id);
                c.pending.delete(msg.id);
                msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
            }
        };
        return c;
    }
    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((res, rej) => {
            this.pending.set(id, { res, rej });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async eval(expression) {
        const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
        return r.result ? r.result.value : undefined;
    }
    async navigate(url) {
        await this.send('Page.navigate', { url });
        await new Promise(r => setTimeout(r, 1500));
    }
    async shot(name) {
        const r = await this.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(SHOT_DIR, name + '.png'), Buffer.from(r.data, 'base64'));
    }
    async setViewport(w, h) {
        await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
        await new Promise(r => setTimeout(r, 500));
    }
    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 轮询等待页面异步状态（最多 timeoutMs，每 400ms 一次）
async function waitFor(c, expr, timeoutMs = 8000) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
        last = await c.eval(expr);
        if (last) return last;
        await sleep(400);
    }
    return last;
}

(async () => {
    // 启动 Chrome
    const profile = path.join(os.tmpdir(), 'chrome-verify-' + Date.now());
    const chrome = spawn(CHROME, [
        '--headless=new', '--remote-debugging-port=9222', `--user-data-dir=${profile}`,
        '--remote-allow-origins=*', '--no-first-run', '--disable-gpu', 'about:blank'
    ], { stdio: 'ignore' });

    // 等待 CDP 端口
    let targets = null;
    for (let i = 0; i < 40; i++) {
        try {
            const r = await fetch('http://127.0.0.1:9222/json/list');
            targets = await r.json();
            if (targets.length) break;
        } catch (e) { /* retry */ }
        await sleep(300);
    }
    if (!targets || !targets.length) throw new Error('Chrome CDP 未就绪');
    const page = targets.find(t => t.type === 'page');
    const c = await CDP.connect(page.webSocketDebuggerUrl);
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    const consoleErrors = [];
    c.ws.addEventListener('message', (ev) => {
        try {
            const msg = JSON.parse(ev.data);
            if (msg.method === 'Runtime.exceptionThrown') {
                consoleErrors.push('EX: ' + (msg.params.exceptionDetails.exception ? msg.params.exceptionDetails.exception.description : msg.params.exceptionDetails.text));
            } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
                consoleErrors.push('CONSOLE: ' + msg.params.args.map(a => a.value || a.description || '').join(' '));
            }
        } catch (e) { /* ignore */ }
    });
    await c.setViewport(1400, 900);

    // 1. 登录注入（先建立 origin）；user 必须是 JSON 对象字符串（loadUserInfo 会 JSON.parse）
    await c.navigate('http://localhost:3000/login.html');
    await c.eval(`localStorage.setItem('token', ${JSON.stringify(ctx.token)}); localStorage.setItem('user', ${JSON.stringify(JSON.stringify({ username: ctx.username }))}); 'ok'`);
    await c.sleep(300);

    // 1.5 前置：恢复 A（重存模型 → 供应商级+模型级 passed）、重置 B 为 unknown（指向 401 延迟 mock）
    await fetch('http://localhost:3000/api/ai/providers/' + ctx.pidA + '/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ctx.token },
        body: JSON.stringify({ models: [
            { id: 'mock-model-a', label: 'Mock Model A' },
            { id: 'mock-model-b', label: 'Mock Model B' }
        ] })
    });
    await fetch('http://localhost:3000/api/ai/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ctx.token },
        body: JSON.stringify({ id: ctx.pidB, name: '坏地址验收站', base_url: 'http://127.0.0.1:18998/v1', api_key: 'sk-bad', wire_api: 'openai' })
    });

    // 2. 设置页初始状态
    await c.navigate('http://localhost:3000/settings.html');
    await c.sleep(800);
    const stA0 = await c.eval(`(() => { const b = document.getElementById('test-state-${ctx.pidA}'); return b ? { cls: b.querySelector('.pc-status').className, text: b.querySelector('span').textContent } : null; })()`);
    const stB0 = await c.eval(`(() => { const b = document.getElementById('test-state-${ctx.pidB}'); return b ? { cls: b.querySelector('.pc-status').className, text: b.querySelector('span').textContent } : null; })()`);
    record('settings_initial_A', stA0 && stA0.text === '测试通过' && stA0.cls.includes('pass'), JSON.stringify(stA0));
    record('settings_initial_B', stB0 && stB0.text === '未测试' && stB0.cls.includes('unknown'), JSON.stringify(stB0));

    // 3. 失败路径：点 B 的测试（列表成功 + 聊天 401 → 红灯 + 保留预览文案）
    await c.eval(`testProvider(${ctx.pidB}, document.querySelector('#pc-${ctx.pidB} .test')); 'clicked'`);
    await c.sleep(1000);
    const stB1 = await c.eval(`(() => { const b = document.getElementById('test-state-${ctx.pidB}'); return b ? { cls: b.querySelector('.pc-status').className, text: b.querySelector('span').textContent } : null; })()`);
    record('settings_testing_B', stB1 && stB1.text === '测试中' && stB1.cls.includes('testing'), JSON.stringify(stB1));
    await c.sleep(2500); // 等待聊天探测 401 返回
    const stB2 = await c.eval(`(() => { const b = document.getElementById('test-state-${ctx.pidB}'); const m = document.getElementById('msg'); return b ? { cls: b.querySelector('.pc-status').className, text: b.querySelector('span').textContent, msg: m ? m.textContent : '' } : null; })()`);
    record('settings_fail_B', stB2 && stB2.text === '测试未通过' && stB2.cls.includes('fail'), JSON.stringify(stB2));
    record('settings_fail_msg', !!(stB2 && stB2.msg.includes('模型列表已读取') && stB2.msg.includes('聊天通道测试未通过')), stB2 ? stB2.msg : '');
    const previewVisible = await c.eval(`(() => { const p = document.getElementById('modelPreview'); return p ? p.style.display !== 'none' : false; })()`);
    record('settings_fail_preview_kept', previewVisible === true, 'preview visible=' + previewVisible);
    await c.shot('01-settings-red-fail');

    // 4. 成功路径：点 A 的测试（指向 mock）
    await c.eval(`testProvider(${ctx.pidA}, document.querySelector('#pc-${ctx.pidA} .test')); 'clicked'`);
    await c.sleep(2500);
    const stA1 = await c.eval(`(() => { const b = document.getElementById('test-state-${ctx.pidA}'); const m = document.getElementById('msg'); return b ? { cls: b.querySelector('.pc-status').className, text: b.querySelector('span').textContent, msg: m ? m.textContent : '' } : null; })()`);
    record('settings_pass_A', stA1 && stA1.text === '测试通过' && stA1.cls.includes('pass'), JSON.stringify(stA1));
    await c.shot('02-settings-green-pass');

    // 5. 主界面：当前模型 A → 绿灯（轮询等待异步加载）
    await c.navigate('http://localhost:3000/index.html');
    const wbA = await waitFor(c, `(() => { const b = document.getElementById('modelTestStatus'); const t = b && b.querySelector('span:not(.tia-model-test-led)'); return t && t.textContent !== '未测试' ? { led: b.querySelector('.tia-model-test-led').className, text: t.textContent } : null; })()`);
    record('workbench_A_green', wbA && wbA.text === '测试通过' && wbA.led.includes('is-pass'), JSON.stringify(wbA));
    await c.shot('03-workbench-modelA-green');

    // 6. 切换模型 B → 灰灯（核心回归）
    await c.eval(`(() => { const s = document.getElementById('modelSelect'); s.value = '${ctx.modelB}'; s.dispatchEvent(new Event('change')); return 'switched'; })()`);
    await c.sleep(2000);
    const wbB = await c.eval(`(() => { const b = document.getElementById('modelTestStatus'); return b ? { led: b.querySelector('.tia-model-test-led').className, text: b.querySelector('span:not(.tia-model-test-led)').textContent } : null; })()`);
    record('workbench_B_gray', wbB && wbB.text === '未测试' && wbB.led.includes('is-idle'), JSON.stringify(wbB));
    await c.shot('04-workbench-modelB-gray');

    // 7. 切回 A → 绿灯（轮询）
    await c.eval(`(() => { const s = document.getElementById('modelSelect'); s.value = '${ctx.modelA}'; s.dispatchEvent(new Event('change')); return 'switched'; })()`);
    const wbA2 = await waitFor(c, `(() => { const b = document.getElementById('modelTestStatus'); const t = b && b.querySelector('span:not(.tia-model-test-led)'); return t && t.textContent === '测试通过' ? { led: b.querySelector('.tia-model-test-led').className, text: t.textContent } : null; })()`);
    record('workbench_A_back_green', wbA2 && wbA2.led.includes('is-pass'), JSON.stringify(wbA2));

    // 8. 刷新主界面 → 状态保持（轮询）
    await c.send('Page.reload');
    const wbA3 = await waitFor(c, `(() => { const b = document.getElementById('modelTestStatus'); const t = b && b.querySelector('span:not(.tia-model-test-led)'); return t && t.textContent !== '未测试' ? { led: b.querySelector('.tia-model-test-led').className, text: t.textContent } : null; })()`);
    record('workbench_refresh_keep', wbA3 && wbA3.text === '测试通过' && wbA3.led.includes('is-pass'), JSON.stringify(wbA3));

    // 9. 窄屏布局
    await c.setViewport(760, 900);
    await c.sleep(600);
    await c.shot('05-workbench-760px');
    const w760 = await c.eval(`(() => { const b = document.getElementById('modelTestStatus'); return b ? { text: b.querySelector('span:not(.tia-model-test-led)').textContent, rect: b.getBoundingClientRect().width } : null; })()`);
    record('workbench_760px', !!w760 && w760.text.length > 0, JSON.stringify(w760));
    await c.setViewport(600, 900);
    await c.sleep(600);
    await c.shot('06-workbench-600px');

    // 10. 配置变更：改 A 的 base_url → 设置页应重置灰灯
    const upd = await fetch('http://localhost:3000/api/ai/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ctx.token },
        body: JSON.stringify({ id: ctx.pidA, name: 'Mock 验收站', base_url: 'http://127.0.0.1:18999/v1', api_key: '', wire_api: 'openai' })
    }).then(r => r.json());
    record('config_update_api', upd.success === true, JSON.stringify(upd));
    await c.navigate('http://localhost:3000/settings.html');
    await c.sleep(1000);
    const stA2 = await c.eval(`(() => { const b = document.getElementById('test-state-${ctx.pidA}'); return b ? { cls: b.querySelector('.pc-status').className, text: b.querySelector('span').textContent } : null; })()`);
    record('settings_reset_after_edit', stA2 && stA2.text === '未测试' && stA2.cls.includes('unknown'), JSON.stringify(stA2));
    await c.shot('07-settings-reset-unknown');

    // 11. 官方 fallback：注册无供应商账号 → 主界面灰灯
    const fallbackUser = 'fb_' + Date.now();
    await fetch('http://localhost:3000/api/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: fallbackUser, password: 'test123456' })
    });
    const fbLogin = await fetch('http://localhost:3000/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: fallbackUser, password: 'test123456' })
    }).then(r => r.json());
    await c.eval(`localStorage.setItem('token', ${JSON.stringify(fbLogin.token)}); localStorage.setItem('user', ${JSON.stringify(JSON.stringify({ username: fallbackUser }))}); 'ok'`);
    await c.navigate('http://localhost:3000/index.html');
    await c.sleep(1500);
    const wbFb = await c.eval(`(() => { const b = document.getElementById('modelTestStatus'); return b ? { led: b.querySelector('.tia-model-test-led').className, text: b.querySelector('span:not(.tia-model-test-led)').textContent } : null; })()`);
    record('official_fallback_gray', !!wbFb && wbFb.text === '未测试' && wbFb.led.includes('is-idle'), JSON.stringify(wbFb));
    await c.shot('08-official-fallback-gray');

    // 输出结果
    if (consoleErrors.length) console.log('页面 console/异常：\n' + consoleErrors.join('\n'));
    console.log(JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(__dirname, 'verify-results.json'), JSON.stringify(results, null, 2));
    chrome.kill();
    process.exit(0);
})().catch(async (e) => {
    console.error('验收脚本失败:', e.message);
    fs.writeFileSync(path.join(__dirname, 'verify-results.json'), JSON.stringify({ error: e.message }, null, 2));
    process.exit(1);
});
