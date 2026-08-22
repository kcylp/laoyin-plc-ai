// SCL / STL 复杂程序压测：状态机 + 多定时器 + 数组 + 故障处理
const { importToTia, stopSharedEngineClients } = require('./engineer-yin-bridge');

// SCL：三工位输送线状态机，含 CASE 状态机、多定时器、数组遍历、故障锁存
const sclComplex = `FUNCTION_BLOCK "Stress_ConveyorFSM"
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1

VAR_INPUT
   StartCmd : Bool;              // 启动指令
   StopCmd : Bool;               // 停止指令
   ResetFault : Bool;            // 故障复位
   StationSensor : Array[1..3] of Bool;   // 三工位到位传感器
   MotorFeedback : Array[1..3] of Bool;   // 三工位电机反馈
END_VAR

VAR_OUTPUT
   MotorRun : Array[1..3] of Bool;        // 三工位电机输出
   SystemState : Int;            // 状态机当前状态
   FaultCode : Int;              // 故障码 0=无
   CycleCount : DInt;            // 完成循环计数
END_VAR

VAR
   StepTimer : Array[1..3] of TON_TIME;   // 各工位节拍定时器
   FaultTimer : TON_TIME;                 // 反馈超时检测
   FaultLatch : Bool;                     // 故障锁存
   CurrentStation : Int;                  // 当前处理工位
   PrevStart : Bool;                      // 启动上升沿检测
   StartPulse : Bool;
END_VAR

VAR_TEMP
   i : Int;
   AllHome : Bool;
END_VAR

BEGIN
    // ---- 启动上升沿 ----
    #StartPulse := #StartCmd AND NOT #PrevStart;
    #PrevStart := #StartCmd;

    // ---- 故障检测：电机输出但反馈迟迟不到 ----
    #FaultTimer(IN := #MotorRun[#CurrentStation] AND NOT #MotorFeedback[#CurrentStation],
                PT := T#3S);
    IF #FaultTimer.Q THEN
        #FaultLatch := TRUE;
        #FaultCode := 100 + #CurrentStation;   // 10X = X 工位反馈超时
    END_IF;

    IF #ResetFault THEN
        #FaultLatch := FALSE;
        #FaultCode := 0;
    END_IF;

    // ---- 急停/故障时全部断开 ----
    IF #StopCmd OR #FaultLatch THEN
        FOR #i := 1 TO 3 DO
            #MotorRun[#i] := FALSE;
        END_FOR;
        #SystemState := 0;
        #CurrentStation := 0;
    ELSE
        // ---- 主状态机 ----
        CASE #SystemState OF
            0:  // 待机：等启动且所有工位归位
                #AllHome := TRUE;
                FOR #i := 1 TO 3 DO
                    IF #MotorFeedback[#i] THEN
                        #AllHome := FALSE;
                    END_IF;
                END_FOR;
                IF #StartPulse AND #AllHome THEN
                    #SystemState := 10;
                    #CurrentStation := 1;
                END_IF;

            10: // 工位运行
                #MotorRun[#CurrentStation] := TRUE;
                #StepTimer[#CurrentStation](IN := #StationSensor[#CurrentStation],
                                            PT := T#2S);
                IF #StepTimer[#CurrentStation].Q THEN
                    #MotorRun[#CurrentStation] := FALSE;
                    #SystemState := 20;
                END_IF;

            20: // 切换到下一工位
                IF #CurrentStation < 3 THEN
                    #CurrentStation := #CurrentStation + 1;
                    #SystemState := 10;
                ELSE
                    #SystemState := 30;
                END_IF;

            30: // 一轮完成
                #CycleCount := #CycleCount + 1;
                #CurrentStation := 0;
                #SystemState := 0;

        ELSE
            #SystemState := 0;
        END_CASE;
    END_IF;
END_FUNCTION_BLOCK
`;

// STL：多网络 + 括号嵌套 + 置复位 + 跳转标签
const stlComplex = `FUNCTION_BLOCK "Stress_StlLogic"
TITLE = complex stl logic
VERSION : 0.1

VAR_INPUT
  Start : Bool;
  Stop : Bool;
  Mode : Bool;
  Interlock : Bool;
END_VAR
VAR_OUTPUT
  MainOut : Bool;
  AuxOut : Bool;
  Alarm : Bool;
END_VAR
VAR
  Latch : Bool;
END_VAR

BEGIN
NETWORK
TITLE = latch with interlock

      A(    ;
      A     #Start;
      O     #Latch;
      )     ;
      AN    #Stop;
      A     #Interlock;
      =     #Latch;

NETWORK
TITLE = main output by mode

      A     #Latch;
      A     #Mode;
      =     #MainOut;

NETWORK
TITLE = aux output inverse mode

      A     #Latch;
      AN    #Mode;
      =     #AuxOut;

NETWORK
TITLE = alarm on interlock loss while latched

      A     #Latch;
      AN    #Interlock;
      S     #Alarm;

NETWORK
TITLE = alarm reset

      A     #Stop;
      R     #Alarm;

END_FUNCTION_BLOCK
`;

(async () => {
    const cases = [
        { name: 'SCL 状态机(CASE+数组+多定时器+故障锁存)', src: sclComplex },
        { name: 'STL 多网络(括号嵌套+置复位)', src: stlComplex },
    ];

    for (const c of cases) {
        console.log(`\n===== ${c.name} =====`);
        const r = await importToTia(c.src, true);
        console.log(`  ok=${r.ok} imported=${JSON.stringify(r.imported)}`);
        console.log(`  本块 errors=${r.errorCount} warnings=${r.warningCount} | 项目其他块 errors=${r.otherBlockErrors}`);
        if (r.autoFixes) console.log(`  autoFixes=${JSON.stringify(r.autoFixes)}`);
        if (!r.ok) {
            (r.messages || []).filter(m => /^Error/i.test(m)).slice(0, 6).forEach(m => console.log('   ' + m));
            if (r.message) console.log('   message: ' + String(r.message).slice(0, 300));
        }
    }
})().finally(() => {
    stopSharedEngineClients();
});
