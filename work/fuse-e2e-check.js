// 融合层 e2e:登录 → env-check(mcpAvailable) → scaffold 直传 spec dryRun → AI 产 spec
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
    const uniq = 'fuse' + Date.now().toString(36);
    await api('POST', '/api/register', null, { username: uniq, password: 'test123456' });
    const login = await api('POST', '/api/login', null, { username: uniq, password: 'test123456' });
    const token = login.json.token;
    console.log('login ok');

    // 1) env-check 融合
    const env = await api('GET', '/api/env-check', token);
    console.log('\nenv-check mcpAvailable=', env.json.mcpAvailable);

    // 2) 直传 spec → ScaffoldProject dryRun(不连博途,离线校验)
    const spec = {
        projectName: 'FuseCheck_Demo',
        plcName: 'PLC_1',
        plcFamily: 'S7-1500',
        tagTable: [{ name: 'TagTable_1', tags: [
            { name: 'BtnStart', dataType: 'Bool', logicalAddress: '%I0.0', commentZhCn: '启动按钮' },
            { name: 'Motor', dataType: 'Bool', logicalAddress: '%Q0.0', commentZhCn: '电机' },
        ] }],
        compile: true,
        save: true,
    };
    const dry = await api('POST', '/api/tia/mcp/scaffold', token, { spec });
    console.log('\nscaffold direct dryRun:', dry.status, 'success=', dry.json.success, 'specSource=', dry.json.specSource, 'executed=', dry.json.executed);
    console.log('dryReport 摘要:', JSON.stringify(dry.json.dryReport).slice(0, 300));

    // 3) 没有 confirmed 不会真建(executed=false 上面已证),试 AI 产 spec 需要模型——本测试账号没配供应商,预期 422
    const ai = await api('POST', '/api/tia/mcp/scaffold', token, { requirement: 'S7-1500 一个电机启停' });
    console.log('\nscaffold AI(无模型账号,预期 422):', ai.status, JSON.stringify(ai.json).slice(0, 120));

    // 清理
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('plc_assistant.db');
    db.prepare('DELETE FROM users WHERE username = ?').run(uniq);
    db.close();
    console.log('\ntest user cleaned');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
