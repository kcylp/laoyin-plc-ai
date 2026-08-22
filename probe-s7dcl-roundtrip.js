// S7DCL 回环实证:手写 .s7dcl → 转 BOM → ImportBlocksFromDocuments → 编译
const { TiaMcpClient } = require('./tia-mcp-client');
const fs = require('fs');
const path = require('path');

(async () => {
    // Bootstrap 规则:.s7dcl 必须 UTF-8 带 BOM
    const dir = path.join(__dirname, 'work', 's7dcl-roundtrip-in');
    const file = path.join(dir, 'S7DCL_RoundTrip.s7dcl');
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '﻿' + text.replace(/^﻿/, ''), 'utf8');
    console.log('BOM 已写入');

    const c = new TiaMcpClient();
    await c.callTool('Connect', {}, 300000);
    await c.callTool('AttachToOpenProject', { projectName: '项目1' }, 60000);

    const imp = await c.callTool('ImportBlocksFromDocuments', {
        softwarePath: 'PLC_1',
        importPath: dir,
        regexName: 'S7DCL_RoundTrip',
        importOption: 'Override',
    }, 180000);
    console.log('-- Import --');
    console.log(TiaMcpClient.textOf(imp).slice(0, 500));

    const cmp = await c.callTool('CompileAndDiagnosePlc', { softwarePath: 'PLC_1' }, 300000);
    const cmpText = TiaMcpClient.textOf(cmp);
    console.log('-- Compile --');
    console.log(cmpText.slice(0, 800));

    c.stop();
    process.exit(0);
})().catch(e => { console.error('FAIL: ' + e.message.slice(0, 400)); process.exit(1); });
