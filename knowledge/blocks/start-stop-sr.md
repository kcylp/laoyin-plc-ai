---
id: "start-stop-sr"
title: "起保停（置位复位版）"
标题: "起保停（置位复位版）"
category: "基础逻辑"
分类: "基础逻辑"
keywords: ["置位", "复位", "SR", "自锁", "启停"]
关键词: ["置位", "复位", "SR", "自锁", "启停"]
applies_to: ["S7-1200", "S7-1500", "S7-200SMART"]
适用: ["S7-1200", "S7-1500", "S7-200SMART"]
difficulty: "入门"
难度: "入门"
generation_status: "full"
可生成性: "full"
generation_mark: "✅"
instructions: ["Contact", "SCoil", "RCoil"]
example_requests: ["用 SR 触发器实现电机起保停：启动置位，停止复位。S7-1200。", "用 RS 触发器实现：启动复位（注意 S7-1200 RS 是 Reset 优先）。"]
review_status: "pending"
source: "知识库_积木库正文_草稿待审.md"
---
## 1.2　起保停（置位/复位版）

**id** `start-stop-sr`

### 名称/别名
**中文**：置位复位起保停 · S/R 线圈版起保停 · 置位优先/复位优先锁存
**英文**：Set/Reset Coil Start-Stop · SR/RS Latch

### 适用场景
不用并联自锁，改用**置位线圈 + 复位线圈**实现保持。适合：状态位多、需要在多处置位或复位（多路启动源、多路停止源）、或希望启停逻辑分散在不同 network 便于阅读的场合。

### 梯形图逻辑描述

```
Network 1:  常开[启动按钮]  →  置位线圈 SCoil[电机运行]
Network 2:  (常开[停止按钮信号 = 0 时断开] 取反 …)  →  复位线圈 RCoil[电机运行]
            实务写法：常闭[停止按钮信号]  并联  常开[热保护故障]  并联  常开[有报警]
                      →  RCoil[电机运行]
```

**指令名纠正（实测）**：置位/复位线圈是 **`SCoil`** / **`RCoil`**，**不是** `CoilSet` / `CoilReset`。
证据：`LAD_TON_SR_博途导出.xml`（从博途导出，地面真值）中 `SCoil`×28、`RCoil`×42。

### 🔴 SR / RS 触发器的命名反直觉（高频错误源）

如果用的是**触发器盒子**（SR / RS）而不是 S/R 线圈，注意官方 Table 7-12 原文：

> "**RS** is a **set dominant** latch where the set dominates. If the set (S1) and reset (R) signals are both true, the output address OUT will be **1**."
> "**SR** is a **reset dominant** latch where the reset dominates. If the set (S) and reset (R1) signals are both true, the output address OUT will be **0**."

**记法：名字的最后一个字母 = 优先者。** RS → **S** 优先（置位赢）；SR → **R** 优先（复位赢）。**与多数人的直觉相反。**

- 优先输入带 `1` 后缀（`S1` / `R1`），且画在**下面**
- 硬约束（官方脚注）："For LAD and FBD: **These instructions must be the right-most instruction in a branch.**"
- **SCL 里没有 SR/RS**（官方标 "Not available"）

**S/R 线圈（不是触发器）的规则不同**：LAD 从上到下、左到右扫描，同一变量**后面的 S/R 覆盖前面的** —— **谁在后面谁赢**。

### 变量表

| 名称建议 | 数据类型 | 方向/存储区 | 说明 |
|---|---|---|---|
| `启动按钮` / `PB_Start` | Bool | I | 现场 NO |
| `停止按钮` / `PB_Stop` | Bool | I | 现场 **NC** |
| `热保护故障` / `OL_Trip` | Bool | I | |
| `有报警` / `Alm_Any` | Bool | M / DB | 报警汇总位（见 4.1） |
| `电机运行` / `Motor_Run` | Bool | Q / M | 被 SCoil / RCoil 操作的锁存位 |

### 参数与整定
无独立整定值。去抖、互检延时同 1.1。

### 常见坑　⚠️【待老殷审】

- **SR / RS 记反** —— 见上。停机安全场景下**必须是复位优先**（SR），即"停止压过启动"。用了 RS（置位优先），启动与停止同时为真时电机会**继续转**。
- **S/R 线圈的"后写赢"规则** —— 如果在程序里先 RCoil 再 SCoil 同一个位，结果是置位。**停机相关的 RCoil 必须放在后面**，或干脆集中在一个 network 里写清楚。
- **双线圈的变种：同一位被多处 SCoil / RCoil。** 比 1.1 的双线圈更难查，因为不是"两个 Coil"而是"S 和 R 分散在四五个 network"。**必须用交叉引用（F11）画出该位的全部写入点**，并在交付文档里列出来。
- **置位版天然不"断电即停"**：`SCoil` 置的位如果在保持性存储区（保持性 M / 保持性 DB），**断电重启后仍为 1，设备可能自启**。这是最危险的一条。
  → 电机运行位**不要放保持区**；或在启动 OB（OB100 首次扫描）里显式复位。
- **`Coil` 与 `SCoil` 混用同一位** = 双线圈的另一种形态，`Coil` 每周期无条件赋值，会把 `SCoil` 的锁存冲掉。

### 上机前必须确认　⚠️【待老殷审】

- [ ] 用的是 **SR（复位优先）**，而不是 RS —— 或已确认业务上确实要置位优先，并写明理由
- [ ] 触发器盒子（若用）**是所在分支的最右侧指令**
- [ ] 交叉引用（F11）列出了该锁存位的**全部** SCoil / RCoil / Coil 写入点，无遗漏、无冲突
- [ ] 锁存位**不在保持性存储区**，或首次扫描已显式复位（断电重启不自启）
- [ ] 停止/报警/热保护三路都进了 RCoil 条件
- [ ] 急停独立硬线，不依赖本逻辑　【惯例，本项目强制】

### 可生成性
**✅ 可自动生成。** `Contact`、`Contact`+`<Negated>`、`SCoil`、`RCoil` 均在白名单（`SCoil`/`RCoil` 有博途导出样板作地面真值）。
⚠️ **但 SR / RS 触发器盒子本身不在白名单**（全项目零实例）—— **要用触发器盒子形式的，当前只可人工编写**。可自动生成的是 **S/R 线圈**形式。

---
