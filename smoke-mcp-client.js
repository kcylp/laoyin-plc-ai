// 冒烟:通过我们的 MCP 客户端调 TiaMcpServer.exe,验证 initialize/tools-list/Bootstrap
// Bootstrap 只读、不连博途,安全。
const { TiaMcpClient } = require('./tia-mcp-client');

(async () => {
    const client = new TiaMcpClient();
    console.log('available=' + client.available());

    const tools = await client.listTools();
    console.log('tools=' + tools.length);
    console.log('前 12 个: ' + tools.slice(0, 12).map(t => t.name).join(', '));

    const r = await client.callTool('Bootstrap', {}, 60000);
    const text = TiaMcpClient.textOf(r);
    console.log('Bootstrap 返回前 400 字:');
    console.log(text.slice(0, 400));

    client.stop();
    console.log('done');
    process.exit(0);
})().catch(e => { console.error('FAIL: ' + e.message); process.exit(1); });
