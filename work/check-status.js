const base = 'http://localhost:3000';
(async () => {
    const uniq = 'st' + Date.now().toString(36);
    await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: uniq, password: 'test123456' }) });
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: uniq, password: 'test123456' }) });
    const token = (await login.json()).token;
    const r = await fetch(base + '/api/tia/mcp/status', { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    console.log('prewarm=', j.prewarm, 'available=', j.available, 'running=', j.running);
    // 清理
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('plc_assistant.db');
    db.prepare('DELETE FROM users WHERE username = ?').run(uniq);
    db.close();
})().catch(e => { console.error(e.message); process.exit(1); });
