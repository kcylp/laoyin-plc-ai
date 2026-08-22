// 单项变异二分:在可用骨架上每次只改一处
const { TiaMcpClient } = require('./tia-mcp-client');
const path = require('path');
const fs = require('fs');

const base = fs.readFileSync(path.join(__dirname, 'work', 's7dcl-clone-in', 'S7DCL_Clone.s7dcl'), 'utf8');
const res = fs.readFileSync(path.join(__dirname, 'work', 's7dcl-clone-in', 'S7DCL_Clone.s7res'), 'utf8');

const outDir = path.join(__dirname, 'work', 's7dcl-variants');
fs.mkdirSync(outDir, { recursive: true });

function variant(name, transform) {
    let text = transform(base.replace(/S7DCL_Clone/g, name));
    fs.writeFileSync(path.join(outDir, name + '.s7dcl'), '﻿' + text.replace(/^﻿/, ''), 'utf8');
    fs.writeFileSync(path.join(outDir, name + '.s7res'), res, 'utf8');
    return name;
}

// V1: MLC 标题换成字面量标题(测字面量合法性)
variant('SDV1LiteralTitle', t => t.replace('S7_NetworkTitle := "MLC_z2"', 'S7_NetworkTitle := "plain literal title"'));

// V2: 加 CTU_INT 静态变量(不加网络)
variant('SDV2CtuStatic', t => t.replace('StartTimer : TON_TIME;', 'StartTimer : TON_TIME;\n        BatchCnt : CTU_INT;'));

// V3: 加完整 CTU 网络(我猜测的写法)
variant('SDV3CtuNetwork', t => t.replace('END_FUNCTION_BLOCK', `    {
        S7_Language := "LAD";
        S7_NetworkTitle := "MLC_ctu"
    }
    NETWORK
        RUNG wire#powerrail
            Contact( #StartCmd )
            { S7_Templates := "value_type := Int" }
            #StartTimer.CTU(
                r := #StopCmd,
                pv := Int#10,
                cv =>
            )
            Coil( #TimerDone )
        END_RUNG
    END_NETWORK
END_FUNCTION_BLOCK`));

// V4: TON 的 et 留空写成 et =>(无尾随空格)——确认这不是坑(其实骨架原本就带)
variant('SDV4EtNoTrail', t => t.replace('et =>  ', 'et =>'));

(async () => {
    const c = new TiaMcpClient();
    await c.callTool('Connect', {}, 300000);
    await c.callTool('AttachToOpenProject', { projectName: '项目1' }, 60000);

    for (const name of ['SDV1LiteralTitle', 'SDV2CtuStatic', 'SDV3CtuNetwork', 'SDV4EtNoTrail']) {
        try {
            const r = await c.callTool('ImportBlocksFromDocuments', {
                softwarePath: 'PLC_1',
                groupPath: '',
                importPath: outDir,
                regexName: '^' + name + '$',
                importOption: 'Override',
            }, 180000);
            const txt = TiaMcpClient.textOf(r);
            const imported = /"importedBlocks":(\d+)/.exec(txt);
            console.log(`${name}: imported=${imported ? imported[1] : '?'} ${txt.slice(0, 160)}`);
        } catch (e) {
            console.log(`${name}: FAILED ${e.message.slice(0, 160)}`);
        }
    }

    c.stop();
    process.exit(0);
})().catch(e => { console.error('FAIL: ' + e.message.slice(0, 400)); process.exit(1); });
