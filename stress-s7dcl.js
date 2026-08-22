// S7DCL 通道压测:手写文本 LAD → importToTia → 在线引擎导入 → 编译
// 场景:双电机互锁 + 运行计时 + 批次计数(自锁/取反/并联/TON/CTU 全覆盖)
const { importToTia, preflightImport, stopSharedEngineClients } = require('./engineer-yin-bridge');

const s7dcl = `{
    S7_IECCheck := "TRUE";
    S7_Optimized := "TRUE";
    S7_PreferredLanguage := "LAD";
    S7_Version := "0.1"
}
FUNCTION_BLOCK "Stress_S7DCL_TwoMotor"
    VAR_INPUT
        StartA : Bool;
        StartB : Bool;
        StopAll : Bool;
    END_VAR
    VAR_OUTPUT
        MotorA : Bool;
        MotorB : Bool;
        BatchDone : Bool;
    END_VAR
    VAR
        RunTimer : TON_TIME;
        BatchCnt : CTU_INT;
    END_VAR

    {
        S7_Language := "LAD";
        S7_NetworkTitle := "电机A自锁且与B互锁"
    }
    NETWORK
        RUNG wire#powerrail
            Contact( #StartA )
            wire#w1
            I_Contact( #StopAll )
            I_Contact( #MotorB )
            Coil( #MotorA )
        END_RUNG
        RUNG wire#powerrail
            Contact( #MotorA )
        END_RUNG wire#w1
    END_NETWORK
    {
        S7_Language := "LAD";
        S7_NetworkTitle := "电机B自锁且与A互锁"
    }
    NETWORK
        RUNG wire#powerrail
            Contact( #StartB )
            wire#w2
            I_Contact( #StopAll )
            I_Contact( #MotorA )
            Coil( #MotorB )
        END_RUNG
        RUNG wire#powerrail
            Contact( #MotorB )
        END_RUNG wire#w2
    END_NETWORK
    {
        S7_Language := "LAD";
        S7_NetworkTitle := "任一电机运行计时5秒"
    }
    NETWORK
        RUNG wire#powerrail
            Contact( #MotorA )
            wire#w3
            { S7_Templates := "time_type := Time" }
            #RunTimer.TON(
                pt := T#5s,
                et =>
            )
        END_RUNG
        RUNG wire#powerrail
            Contact( #MotorB )
        END_RUNG wire#w3
    END_NETWORK
    {
        S7_Language := "LAD";
        S7_NetworkTitle := "计时到累计批次满10批"
    }
    NETWORK
        RUNG wire#powerrail
            Contact( #MotorA )
            { S7_Templates := "value_type := Int" }
            #BatchCnt.CTU(
                r := #StopAll,
                pv := Int#10,
                cv =>
            )
            Coil( #BatchDone )
        END_RUNG
    END_NETWORK
END_FUNCTION_BLOCK
`;

(async () => {
    console.log('=== 预检(本地解析) ===');
    const pre = await preflightImport(s7dcl, 'lad');
    console.log(`  ok=${pre.ok} block=${pre.blockName} type=${pre.blockType} kind=${pre.kind} lang=${pre.language}`);
    if (pre.autoFixes) console.log(`  autoFixes=${JSON.stringify(pre.autoFixes)}`);

    console.log('\n=== 写入(在线引擎通道) ===');
    const r = await importToTia(s7dcl, true);
    console.log(`  ok=${r.ok} imported=${JSON.stringify(r.imported)}`);
    console.log(`  本块 errors=${r.errorCount} warnings=${r.warningCount} | 项目其他块 errors=${r.otherBlockErrors}`);
    if (r.autoFixes) console.log(`  autoFixes=${JSON.stringify(r.autoFixes)}`);
    if (!r.ok) {
        (r.messages || []).slice(0, 6).forEach(m => console.log('   ' + String(m).slice(0, 240)));
        if (r.message) console.log('   message: ' + String(r.message).slice(0, 300));
    }
})().finally(() => {
    stopSharedEngineClients();
});
