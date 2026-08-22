// S7DCL 对照:先回导博途自己导出的文件(格式基准),再回导手写文件
const { TiaMcpClient } = require('./tia-mcp-client');

(async () => {
    const c = new TiaMcpClient();
    await c.callTool('Connect', {}, 300000);
    await c.callTool('AttachToOpenProject', { projectName: '项目1' }, 60000);

    const tries = [
        { label: '博途自导出 StarDelta(含 .s7res)', importPath: require('path').join(__dirname, 'work', 's7dcl-probe'), regexName: 'Stress_StarDelta', importOption: 'Override' },
        { label: '博途自导出 StarDelta(None)', importPath: require('path').join(__dirname, 'work', 's7dcl-probe'), regexName: 'Stress_StarDelta', importOption: 'None' },
        { label: '手写 RoundTrip(Override)', importPath: require('path').join(__dirname, 'work', 's7dcl-roundtrip-in'), regexName: 'S7DCL_RoundTrip', importOption: 'Override' },
    ];
    for (const t of tries) {
        try {
            const r = await c.callTool('ImportBlocksFromDocuments', {
                softwarePath: 'PLC_1',
                importPath: t.importPath,
                regexName: t.regexName,
                importOption: t.importOption,
            }, 180000);
            console.log(`\n== ${t.label} ==`);
            console.log(TiaMcpClient.textOf(r).slice(0, 400));
        } catch (e) {
            console.log(`\n== ${t.label} FAILED: ${e.message.slice(0, 300)}`);
        }
    }

    c.stop();
    process.exit(0);
})().catch(e => { console.error('FAIL: ' + e.message.slice(0, 400)); process.exit(1); });
