// 排查:MCP 连的是哪个 TIA 实例?项目1在哪?
const { TiaMcpClient } = require('./tia-mcp-client');

(async () => {
    const c = new TiaMcpClient();
    const tools = await c.listTools();
    for (const name of ['Connect', 'ListPortalProcessProjects', 'OpenProject']) {
        const t = tools.find(x => x.name === name);
        if (t) console.log(`\n== ${name} ==\n${JSON.stringify(t.inputSchema || {}).slice(0, 600)}`);
    }

    await c.callTool('Connect', {}, 300000);
    const procs = await c.callTool('ListPortalProcessProjects', {}, 60000);
    console.log('\n-- ListPortalProcessProjects --');
    console.log(TiaMcpClient.textOf(procs).slice(0, 1500));

    const proj = await c.callTool('GetProject', {}, 60000).catch(e => ({ err: e.message }));
    console.log('\n-- GetProject --');
    console.log(proj.err || TiaMcpClient.textOf(proj).slice(0, 600));

    c.stop();
    process.exit(0);
})().catch(e => { console.error('FAIL: ' + e.message); process.exit(1); });
