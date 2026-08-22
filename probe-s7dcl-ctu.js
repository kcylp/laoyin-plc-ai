// 修正版 CTU 变体:CTU_INT 实例 + MLC 标题进 .s7res
const { TiaMcpClient } = require('./tia-mcp-client');
const path = require('path');
const fs = require('fs');

const base = fs.readFileSync(path.join(__dirname, 'work', 's7dcl-clone-in', 'S7DCL_Clone.s7dcl'), 'utf8');
const res = fs.readFileSync(path.join(__dirname, 'work', 's7dcl-clone-in', 'S7DCL_Clone.s7res'), 'utf8');

const outDir = path.join(__dirname, 'work', 's7dcl-variants2');
fs.mkdirSync(outDir, { recursive: true });

const name = 'SDV5CtuReal';
const res2 = res + '  - id: MLC_ctu\n    zh-CN: batch counter\n';
const text = base.replace(/S7DCL_Clone/g, name)
    .replace('StartTimer : TON_TIME;', 'StartTimer : TON_TIME;\n        BatchCnt : CTU_INT;')
    .replace('END_FUNCTION_BLOCK', `    {
        S7_Language := "LAD";
        S7_NetworkTitle := "MLC_ctu"
    }
    NETWORK
        RUNG wire#powerrail
            Contact( #StartCmd )
            { S7_Templates := "value_type := Int" }
            #BatchCnt.CTU(
                r := #StopCmd,
                pv := Int#10,
                cv =>
            )
            Coil( #TimerDone )
        END_RUNG
    END_NETWORK
END_FUNCTION_BLOCK`);

fs.writeFileSync(path.join(outDir, name + '.s7dcl'), '﻿' + text.replace(/^﻿/, ''), 'utf8');
fs.writeFileSync(path.join(outDir, name + '.s7res'), res2, 'utf8');

(async () => {
    const c = new TiaMcpClient();
    await c.callTool('Connect', {}, 300000);
    await c.callTool('AttachToOpenProject', { projectName: '项目1' }, 60000);

    try {
        const r = await c.callTool('ImportBlocksFromDocuments', {
            softwarePath: 'PLC_1',
            groupPath: '',
            importPath: outDir,
            regexName: '^' + name + '$',
            importOption: 'Override',
        }, 180000);
        console.log('导入: ' + TiaMcpClient.textOf(r).slice(0, 260));

        const cmp = await c.callTool('CompileAndDiagnosePlc', { softwarePath: 'PLC_1' }, 300000);
        const ct = TiaMcpClient.textOf(cmp);
        console.log('编译: ' + ct.slice(0, 400));
        const myErr = ct.match(new RegExp('Path=' + name + '[^"]*', 'g'));
        console.log('本块消息: ' + JSON.stringify(myErr));
    } catch (e) {
        console.log('FAILED: ' + e.message.slice(0, 200));
    }

    c.stop();
    process.exit(0);
})().catch(e => { console.error('FAIL: ' + e.message.slice(0, 400)); process.exit(1); });
