---
id: "mc-jog"
title: "手动点动"
标题: "手动点动"
category: "运动控制"
分类: "运动控制"
keywords: ["MC_MoveJog", "点动", "手动", "寸动"]
关键词: ["MC_MoveJog", "点动", "手动", "寸动"]
applies_to: ["S7-1500"]
适用: ["S7-1500"]
difficulty: "高级"
难度: "高级"
generation_status: "none"
可生成性: "none"
generation_mark: "none"
instructions: ["MC_MoveJog"]
example_requests: ["MC_MoveJog 点动：HMI 点动按钮按下时轴以设定速度移动，释放停止。S7-1500。", "点动速度分级：慢速点动 10mm/s 用于精细定位，快速点动 100mm/s 用于快速移动。"]
review_status: "pending"
source: "知识库_积木库正文_草稿待审.md"
---
## 5.3　手动点动（运动控制）

**id** `mc-jog`
**用到的指令** `MC_MoveJog`

### 名称/别名
**中文**：轴点动 · 手动点动 · 手动正反转 · JOG
**英文**：Manual Jog · MC_MoveJog · Continuous Jog

### 适用场景
手动让轴正向/反向连续运动，用于对位、装料、检修。与 1.4 `jog-vs-run` 的区别：这里是**运动控制轴**（有速度/加减速概念），不是简单的接触器输出。

### 梯形图逻辑描述

```
Network 1: 点动许可（✅ 可生成）
  常开[允许发运动指令] 串联 常开[手动允许]
      串联 常闭[有报警] 串联 常开[安全状态正常]
      →  线圈[允许点动]

Network 2: 方向请求 + 互锁（✅ 可生成）—— ⚠️ 见下，双向冲突是停车+报错
  常开[正向按钮] 串联 常开[允许点动] 串联 常闭[反向按钮]
      →  线圈[JogFwd请求]
  常开[反向按钮] 串联 常开[允许点动] 串联 常闭[正向按钮]
      →  线圈[JogRev请求]

Network 3: 【🔴 手工添加】MC_MoveJog
  JogForward  ← [JogFwd请求]
  JogBackward ← [JogRev请求]
  Axis        ← 工艺对象
  Velocity    ← [点动速度]      ← ⚠️ 即时生效例外之一
  （S7-1500 另有 Acceleration/Deceleration/Jerk；S7-1200 无）
  输出：InVelocity / Busy / CommandAborted / Error / ErrorID (/ErrorInfo：仅 1200)

Network 4: 状态与报警（✅ 可生成）
  常开[MC_MoveJog.Error] → SCoil[Alm_Jog]，Move([ErrorID])→[轴错误码]
  常开[MC_MoveJog.CommandAborted] → PBox → SCoil[点动被中断]   ← 必须边沿，见下
```

### 🔴 三条平台差异极大的行为（每条都能咬人）

**(1) 双向同时为真 = 停车 **且** 报错 —— 不是"后来者优先"，也不是"忽略"**

**S7-1200** 原文：
> "If both parameters are simultaneously TRUE, the axis stops with **the configured deceleration**. An error is indicated in parameters "Error", "ErrorID", and "ErrorInfo"."
→ **`16#8406` / `16#0001`**。该编号在 S7-1200 工艺对象 **V1 → V8 全部版本稳定不变**（仅描述文字微调）。

**S7-1500** 原文：
> "If both "JogForward" and "JogBackward" are set to TRUE, the axis is braked at **the last valid deceleration**. The error **16#8007** (incorrect direction specification) is output."

⚠️ **减速度依据不同**：S7-1200 用**组态的**减速度；S7-1500 用「**最后一次有效的**」减速度 —— 如果上一个作业用了自定义 Deceleration，双向冲突时的刹车曲线**跟着它走**，不回落到组态默认值。

**→ 写互锁逻辑时不能指望它自己选一个方向。必须在 PLC 侧互锁。**（这就是 Network 2 里串对方常闭的理由。）

**(2) `Velocity` 的符号：两平台行为相反**

**S7-1500**：负值**合法**，静默取绝对值。方向**只由** JogForward/JogBackward 决定。
> `≥ 0.0  The specified value is used.` / `< 0.0  The absolute value of the specified value is used.`

交叉佐证：`DynamicDefaults` 那条"负值 → 取组态默认"的通则**明确把 `MC_MoveJog.Velocity` 和 `MC_MoveVelocity.Velocity` 排除在外**，正好对应前者取绝对值、后者用符号定方向。**两处说法自洽。**

**S7-1200**：负值**非法** → **`16#8402` / `16#0024`**（Value is less than 0）。

**→ 跨平台移植必须显式 `ABS()`。** 反向移植（1200→1500）则是**静默行为变化，更隐蔽**。

**(3) 🔑 `MC_MoveJog.Velocity` 是极少数不需要新触发沿就即时生效的参数**

S7-1200 官方原文（§9.3）：
> "…**Exceptions to this are input parameters "StopMode" of "MC_Power" and "Velocity" of "MC_MoveJog". A change in the input parameter is also applied with "Enable" = TRUE or "JogForward" and "JogBackward".**"

**全部运动指令里只有这两个例外。** 实测时序（手册功能图）：改 Velocity → **InVelocity 立刻复位** → 轴按新目标重新加/减速 → 达到后 InVelocity 再置位。**Busy 全程保持 TRUE。**

**这条对做「点动速度可现场调」的 HMI 很关键** —— 改 DB 里的速度值立刻生效，不用松手再按。

> ⚠️ **S7-1500 侧未证实**：手册无等价的"参数即时生效例外清单"。MC_MoveJog 本就没有 Execute 引脚，推测即时生效是合理的，但**手册无明文**。若工程上依赖，**实机验证**，或改用有明文保障的 `<TO>.Override.Velocity` 通路。

### 🔴 另两条反直觉行为

**(a) 松手之后 `Busy` 还是 TRUE**
时序：`JogFwd↓` → 开始减速 → `InVelocity → FALSE`（离开恒速即刻）→ 减速至静止 → `Busy → FALSE`。
**减速全程 `Busy` 仍为 TRUE** —— 这就是"松开点动按钮后指令尚未结束"。

**漏采陷阱**（S7-1200 明文）：松开点动、**轴还在滑行**时抢发新指令 → `CommandAborted` **只闪一个扫描周期**，轮询式代码会漏采。同样规则适用于 `Error`。

**(b) `Velocity = 0` 的反直觉行为（S7-1500）**
> "An "MC_MoveJog" job with "Velocity" = 0.0 stops the axis with the configured deceleration. When the velocity setpoint zero is reached, the parameter **"InVelocity" will indicate the value "TRUE"**."

**轴停住了，`InVelocity` 仍为 TRUE**（因为"设定速度 0 已达到"），且诊断里 `ConstantVelocity` 与 `Standstill` **同时置位**。
**→ 用 `InVelocity` 判断"轴在动"是错的。**

**S7-1200**：`Velocity = 0` 通常**报错**（低于 start/stop velocity）。

**(c) `InVelocity` 的判据：设定值 vs 实际值**
- **S7-1500**：明确是 **setpoint**（"The velocity setpoint/speed setpoint has been reached"）。**不等价于编码器实际速度达标** —— 实际偏差由 following error monitoring 单独管。
- **S7-1200**：手册只写 "The velocity … was reached"，**未区分设定/实际**。**按未证实处理，不推断。**

### 变量表

| 名称建议 | 数据类型 | 方向/存储区 | 说明 |
|---|---|---|---|
| `正向按钮` / `PB_JogFwd` | Bool | I / HMI | **按住有效** |
| `反向按钮` / `PB_JogRev` | Bool | I / HMI | |
| `JogFwd请求` / `Jog_F` | Bool | M | 已互锁 |
| `JogRev请求` / `Jog_R` | Bool | M | |
| `允许点动` / `En_Jog` | Bool | M | |
| `MC_MoveJog实例` / `Inst_Jog` | MC_MoveJog | 背景 DB | 🔴 手工 |
| `点动速度` / `Jog_Vel` | **Real**（1200）/ **LReal**（1500） | DB | **必须非负**（1200 强制） |
| `Alm_Jog` | Bool | DB | |
| `点动被中断` / `Jog_Aborted` | Bool | M / DB | 边沿捕获所得 |

### 参数与整定

| 参数 | 建议初值 | 范围 | 依据 |
|---|---|---|---|
| **点动速度** | 分度/生产速度 × **0.15** | 分度速度的 **10–30%** | 点动是人眼盯着手动对位用的，人反应时间 0.2–0.3 s。判据：**目标点前 5° 内能靠松手停住**。大惯量/大转盘取 0.1，小负载/精度要求低取 0.3（《整定值》1.4） |
| 加减速时间 | **在工艺对象组态里设**（1200 无入参）；1500 可每作业覆盖 | 小惯量分度盘 100–300 ms / 中等惯量转盘 **300–800 ms** / 大惯量带料 1–3 s | 《整定值》1.5。**减速时间通常应 ≥ 加速时间**（负载减速时惯性做正功，容易过冲） |
| 速度上限（纸面） | `f_max × 60 ÷ PPR_motor` [rpm] | — | PTO 频率限制。见 5.4 的完整讨论 |

### 常见坑　⚠️【待老殷审】

- 🔴 **不在 PLC 侧互锁双向** → 双向同时为真时**停车 + 报错**（1200 `16#8406/16#0001`；1500 `16#8007`），不是"选一个方向"。操作工同时按两个键就报警停机，现场体验极差。**必须互锁。**
- 🔴 **`Velocity` 传负数** → **1200 直接被拒（`16#8402`/`16#0024`）；1500 静默取绝对值**。跨平台必须显式取绝对值。
- 🔴 **用 `InVelocity` 判断"轴在动"** → **1500 上 `Velocity=0` 时轴停着但 `InVelocity=TRUE`**。判"在动"要用 `Busy` 或诊断位 `Standstill`。
- 🔴 **松手后立刻抢发新指令** → `CommandAborted` 只闪一周期，轮询漏采。**用边沿捕获。**
- 🔴 **以为松手后 `Busy` 就变 FALSE** → 减速全程 `Busy` 仍为 TRUE。用 `Busy=FALSE` 作为"可以发下一个指令"的条件是对的，但不能理解为"松手即结束"。
- **点动速度沿用生产速度** → 手动对位时冲过目标点，操作工只能反复来回。
- **`ErrorInfo` 跨平台照抄** → S7-1500 无此输出。
- **`Axis` 引脚接错类型** → **S7-1200 只接 `TO_SpeedAxis`；S7-1500 可接 `TO_SpeedAxis` / `TO_PositioningAxis` / `TO_SynchronousAxis`**（通用③）。
- **报警不监视 `MC_Power.Error`** → 通用⑤(c)：软限位等错误只在 MC_Power 上显示。
- **点动时不检查安全状态** → 点动往往是**人最靠近机器**的工况。安全条件必须串进许可。
- **同一实例被点动和其他指令共用** → 通用⑥：状态与错误信息**互相覆盖**。
- **依赖"1500 上改 Velocity 即时生效"** → **手册无明文**（只有 1200 有）。要依赖就实机验证，或改用 `<TO>.Override.Velocity`。

### 上机前必须确认　⚠️【待老殷审】

- [ ] **双向已在 PLC 侧互锁**，且实测同时按两个键的行为（确认不进报警状态或已接受该行为）
- [ ] `点动速度` 已确认**非负**（1200 强制），且已实测「目标点前 5° 内能松手停住」
- [ ] **不用 `InVelocity` 判断"轴在动"**（1500 上 Velocity=0 时它为 TRUE）
- [ ] `CommandAborted` / `Error` **用边沿捕获**（滑行期只闪一周期）
- [ ] `Axis` 引脚接的工艺对象类型**符合平台限制**（1200 只能 TO_SpeedAxis）
- [ ] **点动时的人身防护**已由机械/安全专业确认（这是人最靠近机器的工况）　【分工声明】
- [ ] **点动时急停仍然有效**（实测拍急停）　【惯例，本项目强制】
- [ ] 报警逻辑同时监视 `MC_Power.Error`
- [ ] `MC_MoveJog` 使用**独立实例**，不与其他指令共用
- [ ] 若依赖"改速度即时生效"：**1200 有明文；1500 需实机验证**（已验证并记录）
- [ ] 加减速时间已在工艺对象里设好并实测无失步/过冲
- [ ] 平台差异已核对（Real/LReal、有无 ErrorInfo、有无 Acceleration 入参）

### 可生成性
**🔴 暂不可自动生成 —— 等 TASK-012A 实证，当前只可人工编写。**
✅ **可生成的部分**：点动许可汇总、双向互锁、`CommandAborted`/`Error` 的边沿捕获与锁存、错误码存储、点动速度的合法性检查（`Ge(0)`，白名单内）。

---
