---
id: "mc-axis-enable"
title: "轴使能 + 稳定延时"
标题: "轴使能 + 稳定延时"
category: "运动控制"
分类: "运动控制"
keywords: ["MC_Power", "轴使能", "使能", "延时"]
关键词: ["MC_Power", "轴使能", "使能", "延时"]
applies_to: ["S7-1500"]
适用: ["S7-1500"]
difficulty: "高级"
难度: "高级"
generation_status: "none"
可生成性: "none"
generation_mark: "none"
instructions: ["MC_Power", "TON"]
example_requests: ["MC_Power 轴使能：使能信号到位后延时 500ms 再给 Enable，等待驱动器就绪。S7-1500。", "使能条件检查：必须在急停释放、驱动器无故障、位置在软限位内才能使能。"]
review_status: "pending"
source: "知识库_积木库正文_草稿待审.md"
---
## 5.1　轴使能 + 稳定延时

**id** `mc-axis-enable`
**用到的指令** `MC_Power` + `TON`

### 名称/别名
**中文**：轴使能 · 轴上电 · 伺服使能 · 驱动使能 + 稳定延时
**英文**：Axis Enable · MC_Power · Servo Enable with Settle Delay

### 适用场景
所有运动控制的**第一步**。使能工艺对象轴，等驱动器自检/电流环建立/抱闸释放完成后，才允许发运动指令。

### 梯形图逻辑描述

```
Network 1: 使能条件汇总（这部分 ✅ 可生成）
  常开[安全状态正常] 串联 常闭[有报警] 串联 常开[方式≠停止]
      串联 常开[驱动器就绪] 串联 常闭[急停辅助动作]
      →  线圈[轴使能请求]

Network 2: 【🔴 手工添加】MC_Power
  Enable ← [轴使能请求]
  Axis   ← 工艺对象（轴）
  StopMode ← 见下（这是两个"即时生效"例外之一）
  输出：Status / Busy / Error / ErrorID (/ ErrorInfo：仅 1200)

Network 3: 稳定延时（这部分 ✅ 可生成）
  常开[MC_Power.Status]  →  T_PowerDly(IN)，PT = 稳定延时
  常开[T_PowerDly.Q]     →  线圈[允许发运动指令]

Network 4: 错误处理（这部分 ✅ 可生成，但必须监视 MC_Power.Error）
  常开[MC_Power.Error]  →  SCoil[Alm_AxisPower]
      →  Move([MC_Power.ErrorID]) → [轴错误码]
      （S7-1200 另存 ErrorInfo；S7-1500 无此输出）
```

**竞品 demo 里也加了这个延时**：`DbTurn.PowerSts → T#50MS → DbTurn.PowerDly`，它取的是 50 ms。

### 变量表

| 名称建议 | 数据类型 | 方向/存储区 | 说明 |
|---|---|---|---|
| `轴使能请求` / `Axis_En_Req` | Bool | M | 汇总条件 |
| `驱动器就绪` / `Drv_Ready` | Bool | I | 驱动器 RDY 信号 |
| `MC_Power实例` / `Inst_Power` | MC_Power | **背景 DB，一轴一个** | 🔴 手工创建 |
| `轴工艺对象` / `Axis_TO` | TO_PositioningAxis 等 | **工艺对象** | 🔴 手工创建 |
| `稳定延时` / `T_PowerDly` | IEC_TIMER | FB→**Static** | ✅ |
| `稳定延时设定` / `PowerDly_PT` | **Time** | DB | 可现场调 |
| `允许发运动指令` / `Motion_Permit` | Bool | M | 所有 MC_Move* 的前置条件 |
| `轴错误码` / `Axis_ErrID` | Word | DB | 存 ErrorID，供诊断 |
| `轴错误信息` / `Axis_ErrInfo` | Word | DB | **仅 S7-1200 有** |
| `Alm_AxisPower` | Bool | DB | 锁存报警（见 4.1） |

### 参数与整定

| 参数 | 建议初值 | 范围 | 依据 |
|---|---|---|---|
| **轴使能后稳定延时** | **300 ms** | **100–500 ms** | 驱动器上电自检、电流环建立、抱闸释放。**有抱闸取 300–500 ms**（抱闸机械释放慢）。竞品取 50 ms（《整定值》2.3） |
| 抱闸释放/施加延时 | 500 ms | 200–500 ms | 查抱闸铭牌；**无数据取 500 ms**（《整定值》2.3） |
| `StopMode` | **视工艺定** —— 这是两个"即时生效"例外之一 | — | 决定去使能时如何停车。**与安全策略相关，须与安全设计一致** |

**实测方法（《整定值》第四节）**：使能后**立即**发运动指令，看是否报错；报错则加长延时。

### 常见坑　⚠️【待老殷审】

- 🔴 **一轴多个 MC_Power 实例** → S7-1200 报 **`16#8201`**（Axis has already been enabled by another "MC_Power" instance）。官方明文强制**一轴一实例**。
- 🔴 **不加稳定延时，使能后立刻发运动指令** → 驱动器还没准备好，指令被拒或轴不动。**S7-1200 上表现为 `16#8007`（It is not possible to enable the axis），ErrorInfo `16#0025`=Restarting / `16#0026`=Executing loading process in RUN mode。**
  ⚠️ **注意：同一个 `16#8007` 在 S7-1500 上是"方向给错了"，完全不同的事。**
- 🔴 **报警逻辑不监视 `MC_Power.Error`** → 见通用⑤(c)，**有一类轴错误只在 MC_Power 上显示**，别处永远看不到。
- **`StopMode` 当普通参数改** → 它是**两个"即时生效"例外之一**（另一个是 `MC_MoveJog.Velocity`），改了立刻生效，不用新触发沿。这既是便利也是风险 —— **不要在运行中随手改**。
- **去使能时机没设计** → 报警时立刻去使能 = Cat 0 硬停，大惯量负载可能坠落/甩出。
  → **Cat 1 的停机延时必须由安全侧器件计时（安全继电器安全延时输出 / 驱动器 SS1），绝不用标准 PLC 的 TON**（《整定值》第三节）。
- **背景 DB 相关报错**【本机】：
  EN: `Instance data block does not match called FB.` / ZH: `背景数据块与被调用 FB 不匹配。`
  EN: `Time stamp conflict of the instance data block.` / ZH: `背景数据块时间戳冲突。`
  ZH: `背景数据块缺失。`
  ⚠️ 社区流传的 `The instance ... is not defined` / `A block instance must be assigned` **已判定为伪造**，不采信。
- **抱闸控制交给 PLC 输出但不与使能同步** → 抱闸先松、使能后到 → 负载下坠。**抱闸时序必须与使能严格配合，且优先用驱动器自带的抱闸控制**。
- 🔴 **运行中改稳定延时 PT 无效**（官方 Table 7-19："Changing PT has no effect while the timer runs."）→ 先复位定时器。
- **`ErrorInfo` 跨平台照抄** → **S7-1500 没有 `ErrorInfo` 输出**（只有 ErrorID）。1200 的代码搬到 1500 上引用 ErrorInfo 会报错。

### 上机前必须确认　⚠️【待老殷审】

- [ ] **一轴只有一个 `MC_Power` 实例**（多轴则每轴独立实例 + 独立背景 DB）
- [ ] **稳定延时已实测**（使能后立即发运动指令，确认不报错），值进交付文档整定值表
- [ ] **报警逻辑同时监视了 `MC_Power` 的 `Error`**（有一类错误只在那里显示）
- [ ] 轴错误码（ErrorID / ErrorInfo）已存进 DB 并可在 HMI 查看
- [ ] 平台已确认（**1200 有 ErrorInfo、Real；1500 无 ErrorInfo、用 LReal**），代码与之匹配
- [ ] `StopMode` 取值已与**安全设计一致**，且已实测去使能时的实际停车行为
- [ ] **Cat 1 停机延时不在 PLC 里**，由安全继电器安全延时输出或驱动器 SS1 实现　【惯例，本项目强制】
- [ ] 抱闸时序已验证（**空载 + 带载各试一次**，确认不下坠）
- [ ] 驱动器就绪信号已接入使能条件
- [ ] 急停时的轴行为已实测（拍急停，观察轴如何停、是否产生新危险）
- [ ] 工艺对象组态（轴类型、驱动接口、机械参数、动态限值、限位）已完成并记录进交付文档

### 可生成性
**🔴 暂不可自动生成 —— 等 TASK-012A 实证，当前只可人工编写。**
根因：`MC_Power` 是带背景 DB 的 FB 调用 + 工艺对象引用，`<Call>` 与工艺对象引用语法**全项目零实例**。
✅ **可生成的部分**：使能条件汇总、稳定延时（`TON`）、错误锁存与存码（`SCoil`/`Move`）、允许发运动指令的派生位。

---
