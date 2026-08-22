// S7DCL 实证研究:导出真实块看格式,评估 AI 手写难度
const { TiaMcpClient } = require('./tia-mcp-client');

(async () => {
    const c = new TiaMcpClient();
    const tools = await c.listTools();
    for (const name of ['ExportBlocksAsDocuments', 'ExportAsDocuments', 'ImportBlocksFromDocuments', 'ImportFromDocuments']) {
        const t = tools.find(x => x.name === name);
        if (t) console.log(`\n== ${name} ==\nschema: ${JSON.stringify(t.inputSchema || {}).slice(0, 700)}`);
    }

    // 连接 + 挂到已打开的项目1
    console.log('\n-- Connect --');
    const conn = await c.callTool('Connect', {}, 300000);
    console.log(TiaMcpClient.textOf(conn).slice(0, 200));
    const att = await c.callTool('AttachToOpenProject', { projectName: '项目1' }, 60000);
    console.log('-- Attach 项目1 --');
    console.log(TiaMcpClient.textOf(att).slice(0, 200));

    const state = await c.callTool('GetState', {}, 30000);
    console.log('-- GetState --');
    console.log(TiaMcpClient.textOf(state).slice(0, 300));

    // 导出三种语言各一块成 S7DCL
    const outDir = require('path').join(__dirname, 'work', 's7dcl-probe');
    require('fs').mkdirSync(outDir, { recursive: true });
    for (const block of ['Stress_StarDelta', 'Stress_ConveyorFSM', 'Stress_StlLogic', 'Stress_Pid']) {
        try {
            const r = await c.callTool('ExportBlocksAsDocuments', {
                softwarePath: 'PLC_1',
                exportPath: outDir,
                regexName: '^' + block + '$',
            }, 120000);
            console.log(`\n-- Export ${block} --`);
            console.log(TiaMcpClient.textOf(r).slice(0, 400));
        } catch (e) {
            console.log(`\n-- Export ${block} FAILED: ${e.message.slice(0, 250)}`);
        }
    }

    c.stop();
    process.exit(0);
})().catch(e => { console.error('FAIL: ' + e.message); process.exit(1); });
