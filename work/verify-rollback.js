// 写入历史回滚端到端验证:
// 写 v1 → 覆盖 v2 → 查历史(2条) → 回滚 v1 → 导出块确认内容回到 v1
const base = 'http://localhost:3000';
const { TiaMcpClient } = require('../tia-mcp-client');
const fs = require('fs');
const path = require('path');

async function api(method, url, token, body) {
    const r = await fetch(base + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json };
}

const v1 = `FUNCTION_BLOCK "Revert_Test"
{ S7_Optimized_Access := 'TRUE' }
VAR_INPUT
   In1 : Bool;
END_VAR
VAR_OUTPUT
   Out1 : Bool;
END_VAR
BEGIN
   #Out1 := #In1;
END_FUNCTION_BLOCK
`;
const v2 = `FUNCTION_BLOCK "Revert_Test"
{ S7_Optimized_Access := 'TRUE' }
VAR_INPUT
   In1 : Bool;
END_VAR
VAR_OUTPUT
   Out1 : Bool;
END_VAR
BEGIN
   #Out1 := NOT #In1;
END_FUNCTION_BLOCK
`;

async function preflightAndImport(token, xml, overwrite) {
    const pre = await api('POST', '/api/tia/preflight', token, { xml, lang: 'scl' });
    if (!pre.json.success) return { ok: false, message: '预检失败:' + pre.json.message };
    return api('POST', '/api/tia/import', token, { xml, lang: 'scl', confirmed: true, confirmationToken: pre.json.confirmationToken, overwrite });
}

(async () => {
    const uniq = 'rv' + Date.now().toString(36);
    await api('POST', '/api/register', null, { username: uniq, password: 'test123456' });
    const login = await api('POST', '/api/login', null, { username: uniq, password: 'test123456' });
    const token = login.json.token;

    console.log('1) 写入 v1(Out1 := In1, 覆盖写):');
    const r1 = await preflightAndImport(token, v1, true);
    console.log('  ok=', r1.json.ok, 'stage=', r1.json.stage, 'msg=', r1.json.message, 'imported=', JSON.stringify(r1.json.imported), 'errCount=', r1.json.errorCount);

    console.log('2) 写入 v2(Out1 := NOT In1, 覆盖写):');
    const r2 = await preflightAndImport(token, v2, true);
    console.log('  ok=', r2.json.ok, 'stage=', r2.json.stage, 'msg=', r2.json.message, 'imported=', JSON.stringify(r2.json.imported), 'errCount=', r2.json.errorCount);

    console.log('3) 查历史:');
    const hist = await api('GET', '/api/tia/history?blockName=Revert_Test', token);
    const items = hist.json.history || [];
    console.log('  ' + items.length + ' 条');
    items.forEach(h => console.log(`  #${h.id} ${h.created_at} ${h.overwrite ? '覆盖' : '写入'}`));
    // 两条:最新在前(items[0]=v2),最旧在后(items[1]=v1)
    const v1row = items[items.length - 1];
    console.log('  v1 版本 id=', v1row.id);

    console.log('4) 回滚到 v1:');
    const v = await api('GET', '/api/tia/history/' + v1row.id, token);
    const roll = await preflightAndImport(token, v.json.version.content, true);
    console.log('  回滚 ok=', roll.json.ok, roll.json.message || '');

    console.log('5) 导出块确认内容回到 v1:');
    const mc = new TiaMcpClient();
    await mc.callTool('Connect', {}, 300000);
    await mc.callTool('AttachToOpenProject', { projectName: '项目1' }, 60000);
    const outDir = path.join(__dirname, '..', 'work', 'rollback-check');
    fs.mkdirSync(outDir, { recursive: true });
    await mc.callTool('ExportBlocksAsDocuments', { softwarePath: 'PLC_1', exportPath: outDir, regexName: '^Revert_Test$' }, 120000);
    const files = fs.readdirSync(outDir);
    const sclFile = files.find(f => f.includes('Revert_Test'));
    const content = fs.readFileSync(path.join(outDir, sclFile), 'utf8');
    console.log('  含 v1 特征 `:= #In1;`: ', content.includes(':= #In1;'));
    console.log('  含 v2 特征 `:= NOT #In1;`: ', content.includes('NOT #In1'));

    // 清理块 + 账号 + 临时导出
    for (const b of ['Revert_Test']) {
        try { await mc.callTool('DeleteBlock', { softwarePath: 'PLC_1', blockName: b }, 60000).catch(() => {}); } catch {}
    }
    mc.stop();
    fs.rmSync(outDir, { recursive: true, force: true });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('plc_assistant.db');
    db.prepare('DELETE FROM tia_write_history WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(uniq);
    db.prepare('DELETE FROM users WHERE username = ?').run(uniq);
    db.close();
    console.log('\n清理完成');
    process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
