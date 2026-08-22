// 对照:克隆骨架(只改块名) vs 手写(补了 .s7res)
const { TiaMcpClient } = require('./tia-mcp-client');
const path = require('path');

(async () => {
    const c = new TiaMcpClient();
    await c.callTool('Connect', {}, 300000);
    await c.callTool('AttachToOpenProject', { projectName: '项目1' }, 60000);

    for (const t of [
        { label: '克隆骨架', dir: 's7dcl-clone-in', name: 'S7DCL_Clone' },
        { label: '手写+res', dir: 's7dcl-roundtrip-in', name: 'S7DCL_RoundTrip' },
    ]) {
        try {
            const r = await c.callTool('ImportBlocksFromDocuments', {
                softwarePath: 'PLC_1',
                groupPath: '',
                importPath: path.join(__dirname, 'work', t.dir),
                regexName: t.name,
                importOption: 'Override',
            }, 180000);
            console.log(`== ${t.label}: ` + TiaMcpClient.textOf(r).slice(0, 260));
        } catch (e) {
            console.log(`== ${t.label} FAILED: ${e.message.slice(0, 200)}`);
        }
    }

    c.stop();
    process.exit(0);
})().catch(e => { console.error('FAIL: ' + e.message.slice(0, 400)); process.exit(1); });
