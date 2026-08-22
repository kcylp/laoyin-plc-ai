// 导出现有计数器/模拟量块拿 S7DCL 真实语法 + 用 None 选项重试手写导入
const { TiaMcpClient } = require('./tia-mcp-client');
const path = require('path');

(async () => {
    const c = new TiaMcpClient();
    await c.callTool('Connect', {}, 300000);
    await c.callTool('AttachToOpenProject', { projectName: '项目1' }, 60000);

    const outDir = path.join(__dirname, 'work', 's7dcl-probe');
    for (const block of ['Stress_Counter', 'Stress_AnalogIn']) {
        const r = await c.callTool('ExportBlocksAsDocuments', {
            softwarePath: 'PLC_1',
            exportPath: outDir,
            regexName: '^' + block + '$',
        }, 120000);
        console.log(`导出 ${block}: ` + TiaMcpClient.textOf(r).slice(0, 150));
    }

    try {
        const r2 = await c.callTool('ImportBlocksFromDocuments', {
            softwarePath: 'PLC_1',
            groupPath: '',
            importPath: path.join(__dirname, 'work', 's7dcl-roundtrip-in'),
            regexName: 'S7DCL_RoundTrip',
            importOption: 'None',
        }, 180000);
        console.log('\n手写导入(None): ' + TiaMcpClient.textOf(r2).slice(0, 300));
    } catch (e) {
        console.log('\n手写导入(None) FAILED: ' + e.message.slice(0, 200));
    }

    c.stop();
    process.exit(0);
})().catch(e => { console.error('FAIL: ' + e.message.slice(0, 400)); process.exit(1); });
