---
id: "edge-detect"
title: "上升沿触发一次"
标题: "上升沿触发一次"
category: "基础逻辑"
分类: "基础逻辑"
keywords: ["上升沿", "单次", "触发", "边沿"]
关键词: ["上升沿", "单次", "触发", "边沿"]
applies_to: ["S7-1200", "S7-1500", "S7-200SMART"]
适用: ["S7-1200", "S7-1500", "S7-200SMART"]
difficulty: "入门"
难度: "入门"
generation_status: "full"
可生成性: "full"
generation_mark: "✅"
instructions: ["PBox"]
example_requests: ["上升沿触发计数：每按一次启动按钮，产量计数器加 1。S7-1200。", "下降沿触发：使用 NBox 检测按钮释放瞬间（注意 NBox 未在全部版本验证）。"]
review_status: "pending"
source: "知识库_积木库正文_草稿待审.md"
---
## 1.6　上升沿触发一次

**id** `edge-detect`

### 名称/别名
**中文**：上升沿 · 边沿检测 · 单次触发 · 一个扫描周期脉冲 · 沿触发
**英文**：Rising Edge Detection · One-Shot · P_TRIG / Positive Edge

### 适用场景
按钮按一下只执行一次（计数 +1、写一次配方、发一次运动指令、翻转一个状态）。**只要出现"按住不放会重复执行"的问题，答案就是这条积木。**

### 梯形图逻辑描述

```
常开[触发信号]  →  PBox（上升沿）  →  后续动作（Move / SCoil / 计数 …）
```

**四种边沿形式（官方口径）**

| 形式 | LAD 中的位置限制 | 说明 |
|---|---|---|
| P / N **触点** | "can be located anywhere in the network **except the end of a branch**" | 串在能流里 |
| P / N **线圈** | "can be located anywhere in the network" | |
| **P_TRIG / N_TRIG** | "**cannot be located at the beginning or end of a network**" | 靠能流做 CLK，两头都不行 |
| **R_TRIG / F_TRIG** | SCL 用（LAD 也可调用） | **是 FB，边沿位在实例里，天然唯一** |

白名单里已实证的只有 **`PBox`（上升沿）**。
⚠️ **下降沿 `NBox` 未经验证**（全项目零实例）—— 需要下降沿时，当前**只可人工编写**，或用「取反 + 上升沿」变通（`Not` 在白名单内）。

### 🔴 M_BIT 机制：三个坑一次踩

官方原文（S7-1200 System Manual §7.1.3, p.181）：

> "All edge instructions use a **memory bit (M_BIT)** to store the previous state of the input signal being monitored."
>
> **Note**: "Edge instructions evaluate the input and memory-bit values **each time they are executed, including the first execution**. You must account for the initial states… either to allow or to avoid edge detection on the first scan."
>
> "**you should use a unique bit for each edge instruction, and you should not use this bit any other place in your program.** You should also avoid temporary memory… **Use only M, global DB, or Static memory (in an instance DB) for M_BIT memory assignments.**"

| 坑 | 后果 |
|---|---|
| **在被多次调用的 FB 里用 M 位** | 多个实例共用同一 M_BIT，边沿**互相吞掉** → 必须放 **Static**（多重实例） |
| **FC 里没有 Static** | 只能挂 M 或全局 DB；FC 被多次调用时同样串味 |
| **在条件跳转 / 不是每周期都执行的代码里用边沿** | 根因是 "evaluate … each time they are **executed**"。被 JMP 跳过的周期不更新 M_BIT，恢复执行时把**跨多周期的变化当成一次新边沿** |
| **首次扫描** | 边沿指令第一次执行时也会评估，初值没设计好会**误触发** |

### 变量表

| 名称建议 | 数据类型 | 方向/存储区 | 说明 |
|---|---|---|---|
| `触发信号` / `Trig` | Bool | I / M / DB | 被检测的信号 |
| `触发沿` / `Trig_P` | Bool | **FB→Static / FC→M 或全局 DB** | M_BIT。**每个边沿指令一个独占位** |
| （输出） | Bool / 任意 | — | 沿驱动的动作 |

**命名建议**：M_BIT 一律带 `_P` / `_N` 后缀并与被检测信号同名前缀（`PB_Start_P`），便于交叉引用时一眼看出归属。

### 参数与整定
无整定值。**但去抖必须在边沿之前做** —— 机械按钮弹跳 5–20 ms，不去抖会产生多个沿。优先用 CPU 硬件输入滤波（10–30 ms，《整定值》2.1）。

### 常见坑　⚠️【待老殷审】

- **M_BIT 复用** —— 两个边沿指令用同一个 M 位，互相吞边沿。官方原文明确要求 "a **unique** bit for each edge instruction"。
- **FB 多实例用 M 位** —— 最隐蔽的一条：单实例时完全正常，加第二个实例才出问题，而且是**间歇性丢触发**，极难查。→ **放 Static**。
- **跳转区内用边沿** —— 被 JMP 跳过的周期不更新 M_BIT。
  相关报错【本机】：EN: `The jump label '{1}' is not defined.`
- **首次扫描误触发** —— 上电瞬间就发了一次动作。
- **没去抖** —— 按一下计数加了 3。
- ⚠️ **一处未消解的矛盾（诚实标注）**：本机 DLL 有一条
  EN: `The edge evaluation instructions can only access the parameters defined in the InOut or Temp sections of the block interface.`
  ZH: `中指令的边沿评估只能访问块接口 InOut 或 Temp 部分中所定义的参数。`
  这与手册"应避免 temporary memory 作 M_BIT"**表面冲突**。两者大概率讲的是不同对象（**指令操作数可位于哪些接口段** vs **M_BIT 存储位该放哪**），但**未完全证实**。→ **进产品前需真机验证。**
- **SCL 里没有 P/N 触点线圈**（官方："For SCL: You must write code to replicate this function"）→ 用 **R_TRIG / F_TRIG**（是 FB，边沿位在实例里，**天然唯一**）。这是 SCL 结构性优于 M 位方案的地方。

### 上机前必须确认　⚠️【待老殷审】

- [ ] 每个边沿指令的 M_BIT **独占**（交叉引用 F11 逐个查，无复用）
- [ ] FB 里的边沿位在 **Static**，不是 M
- [ ] 输入去抖已生效（优先硬件滤波），按一下只触发一次（**实机连按十次计数验证**）
- [ ] 边沿指令**不在条件跳转区内**，或已确认跳转不影响
- [ ] 首次扫描行为已设计（该触发的触发、不该触发的不触发），上电实测过
- [ ] 若用了下降沿：**当前 `NBox` 未验证，确认是人工编写的**
- [ ] 上述「InOut/Temp」矛盾项已在本机真机验证并记录结论

### 可生成性
**✅ 可自动生成**（上升沿 `PBox`，有实证 `FB_LAD_v3 N2`）。
⚠️ **下降沿 `NBox` 未验证，不在白名单** —— 需要下降沿的，当前只可人工编写，或用 `Not` + `PBox` 变通。

---
