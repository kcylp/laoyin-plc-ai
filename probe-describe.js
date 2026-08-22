// 实测 DescribeBlockLogic:把博途里的真实梯形图读成可读逻辑
const { TiaMcpClient } = require('./tia-mcp-client');

(async () => {
    const c = new TiaMcpClient();
    await c.callTool('Connect', {}, 300000);
    await c.callTool('AttachToOpenProject', { projectName: '项目1' }, 60000);

    const tree = await c.callTool('GetSoftwareTree', { softwarePath: 'PLC_1' }, 60000);
    const treeText = TiaMcpClient.jsonOf(tree).tree.replace(/```/g, '');

    // 找两个 LAD 块:Stress_StarDelta(星三角) 和 Stress_S7DCL_TwoMotor(手写)
    for (const block of ['Stress_StarDelta', 'Stress_S7DCL_TwoMotor']) {
        const line = treeText.split('\n').find(l => l.includes(block));
        if (!line) { console.log(`\n${block}: 树里没找到`); continue; }
        // 块直接在 Program blocks 下一级:blockPath = 'Program blocks/' + 块名
        const blockPath = 'Program blocks/' + block;
        console.log(`\n== ${block} (${blockPath}) ==`);
        try {
            const r = await c.callTool('DescribeBlockLogic', { softwarePath: 'PLC_1', blockPath }, 60000);
            const text = TiaMcpClient.textOf(r);
            console.log(text.slice(0, 1200));
        } catch (e) {
            console.log('  FAILED: ' + e.message.slice(0, 300));
        }
    }

    c.stop();
    process.exit(0);
})().catch(e => { console.error('FAIL: ' + e.message.slice(0, 400)); process.exit(1); });
