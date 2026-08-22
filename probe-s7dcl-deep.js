// S7DCL 导入失败深挖:dump stderr + 试单文件工具
const { TiaMcpClient } = require('./tia-mcp-client');
const path = require('path');

(async () => {
    const c = new TiaMcpClient();
    await c.callTool('Connect', {}, 300000);
    await c.callTool('AttachToOpenProject', { projectName: '项目1' }, 60000);

    const dumpStderr = () => {
        const lines = c.stderrLog;
        const start = Math.max(0, lines.findIndex(l => /fail:|错误|Exception|error/i.test(l)) - 2);
        console.log('[stderr 异常段]');
        lines.slice(Math.max(0, start)).forEach(l => console.log('  ' + l.slice(0, 260)));
    };

    try {
        const r = await c.callTool('ImportFromDocuments', {
            softwarePath: 'PLC_1',
            groupPath: '',
            importPath: path.join(__dirname, 'work', 's7dcl-probe'),
            fileNameWithoutExtension: 'Stress_StarDelta',
            importOption: 'Override',
        }, 180000);
        console.log('== ImportFromDocuments 单文件(自导出) ==');
        console.log(TiaMcpClient.textOf(r).slice(0, 500));
    } catch (e) {
        console.log('== ImportFromDocuments FAILED: ' + e.message.slice(0, 200));
        dumpStderr();
    }

    try {
        const r2 = await c.callTool('ImportBlocksFromDocuments', {
            softwarePath: 'PLC_1',
            groupPath: '',
            importPath: path.join(__dirname, 'work', 's7dcl-roundtrip-in'),
            regexName: 'S7DCL_RoundTrip',
            importOption: 'Override',
        }, 180000);
        console.log('\n== ImportBlocksFromDocuments(手写) ==');
        console.log(TiaMcpClient.textOf(r2).slice(0, 500));

        const cmp = await c.callTool('CompileAndDiagnosePlc', { softwarePath: 'PLC_1' }, 300000);
        console.log('\n== Compile ==');
        console.log(TiaMcpClient.textOf(cmp).slice(0, 700));
    } catch (e) {
        console.log('\n== 手写导入 FAILED: ' + e.message.slice(0, 200));
        dumpStderr();
    }

    c.stop();
    process.exit(0);
})().catch(e => { console.error('FAIL: ' + e.message.slice(0, 400)); process.exit(1); });
