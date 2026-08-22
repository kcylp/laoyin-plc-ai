const base = 'http://localhost:3000';
async function api(method, url, token, body) {
    const r = await fetch(base + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
}
(async () => {
    const uniq = 'vd' + Date.now().toString(36);
    await api('POST', '/api/register', null, { username: uniq, password: 'test123456' });
    const login = await api('POST', '/api/login', null, { username: uniq, password: 'test123456' });
    const token = login.json.token;

    const t0 = Date.now();
    const tree = await api('GET', '/api/tia/mcp/software-tree', token);
    const t1 = Date.now();
    console.log(`software-tree 耗时 ${t1 - t0}ms, connected=${tree.json.connected}, project=${tree.json.project}`);
    console.log(`块数: ${tree.json.blocks ? tree.json.blocks.length : 0}`);
    const ladBlock = (tree.json.blocks || []).find(b => b.name === 'Stress_StarDelta') || (tree.json.blocks || []).find(b => b.lang === 'LAD');
    console.log('LAD 块:', JSON.stringify(ladBlock));

    const desc = await api('POST', '/api/tia/mcp/describe-block', token, { blockPath: ladBlock.path, name: ladBlock.name });
    console.log(`\n解读 ${desc.json.blockName} (${desc.json.language}) 耗时 ${Date.now() - t1}ms:`);
    console.log(desc.json.readable);

    // 清理
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('plc_assistant.db');
    db.prepare('DELETE FROM users WHERE username = ?').run(uniq);
    db.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
