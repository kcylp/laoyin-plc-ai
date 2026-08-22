// 端到端:真实登录 -> 调 MCP 端点(状态/工具清单/连接/编译诊断)
const base = 'http://localhost:3000';

async function api(method, urlPath, token, body) {
    const r = await fetch(base + urlPath, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json };
}

(async () => {
    const uniq = 'mcp' + Date.now().toString(36);
    const reg = await api('POST', '/api/register', null, { username: uniq, password: 'test123456' });
    console.log('register:', reg.status, JSON.stringify(reg.json).slice(0, 100));

    const login = await api('POST', '/api/login', null, { username: uniq, password: 'test123456' });
    console.log('login:', login.status, 'token=', !!login.json.token);
    const token = login.json.token;

    const status = await api('GET', '/api/tia/mcp/status', token);
    console.log('\nmcp/status:', status.status, JSON.stringify(status.json).slice(0, 300));

    const tools = await api('GET', '/api/tia/mcp/tools', token);
    console.log('\nmcp/tools:', tools.status, 'count=', tools.json.count, 'name=', tools.json.tools && tools.json.tools[0] && tools.json.tools[0].name);

    // 只读:编译诊断(GETState / CompileAndDiagnosePlc 需要已连接+项目,这里先试只读安全工具)
    const bootstrap = await api('POST', '/api/tia/mcp/call', token, { name: 'Bootstrap', args: {}, timeoutMs: 60000 });
    console.log('\nmcp/call Bootstrap:', bootstrap.status, 'json.ready=', bootstrap.json.json && bootstrap.json.json.ready);

    // 危险工具防护:不带 confirmed 应被拒绝
    const danger = await api('POST', '/api/tia/mcp/call', token, { name: 'DownloadToPlc', args: {} });
    console.log('\nmcp/call DownloadToPlc(no confirmed):', danger.status, JSON.stringify(danger.json).slice(0, 120));

    // 清理测试账号
    await fetch('http://localhost:3000/api/admin/delete-user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: uniq }) }).catch(() => {});
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
