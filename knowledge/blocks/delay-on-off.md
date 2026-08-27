---
id: "delay-on-off"
title: "通电延时 / 断电延时"
标题: "通电延时 / 断电延时"
category: "基础逻辑"
分类: "基础逻辑"
keywords: ["延时", "延迟", "TON", "TOF"]
关键词: ["延时", "延迟", "TON", "TOF"]
applies_to: ["S7-1200", "S7-1500", "S7-200SMART"]
适用: ["S7-1200", "S7-1500", "S7-200SMART"]
difficulty: "入门"
难度: "入门"
generation_status: "partial"
可生成性: "partial"
generation_mark: "⚠️"
instructions: ["TON"]
example_requests: ["电机启动延时 5 秒再合主接触器：启动信号后先预吹风，再延时合闸。S7-1200。", "断电延时保持运行：停止信号消失后继续运行 3 秒再停（用 TON 变通实现 TOF）。"]
review_status: "pending"
source: "知识库_积木库正文_草稿待审.md"
---
## 1.8　通电延时 / 断电延时

**id** `delay-on-off`

### 名称/别名
**中文**：通电延时 · 断电延时 · 延时接通 · 延时断开 · 延迟
**英文**：On-Delay (TON) · Off-Delay (TOF) · Timer Delay

### 适用场景
条件成立后等一会儿再动作（通电延时，TON）；条件消失后再保持一会儿才断（断电延时，TOF）。典型用途：轴使能后稳定延时、到位后机械稳定延时、风机停后延时停加热、气缸换向间隔。

### 梯形图逻辑描述

**通电延时（TON，已实证）**

```
常开[条件]  →  TON(IN)，PT = 延时时间
TON.Q  →  线圈[延时后动作]
```

**断电延时（TOF，⚠️ 未验证 —— 用 TON 变通）**

`TOF` **不在白名单**（全项目零实例，未经验证）。用 TON 变通实现"断电延时"：

```
Network 1: 条件消失时开始计时
  常闭[条件]  →  TON_off(IN)，PT = 保持时间
Network 2: 输出 = 条件为真 OR (条件已假但计时未到)
  常开[条件]  并联  (常闭[条件] 串联 常闭[TON_off.Q])
      →  线圈[延时断开输出]
      （O 块 Card=2）
```

即：条件在时输出在；条件走了，只要 TON_off 还没到，输出继续保持。

**TON 写法要点（《技术底座》2.5）**

- 引脚名**大写**：`IN` / `PT` / `Q` / `ET`（与触点/线圈的小写 `in`/`out`/`operand` 不同）
- 未接的输出（如 `ET`）必须显式接 `<OpenCon>`
- 实例归属：**FB 里放 Static**，**FC 里** `Scope="LocalVariable"` 或挂全局 DB
- 每个定时器占 **16 字节** `IEC_Timer` DB 结构；"**STEP 7 automatically creates the DB when you insert the instruction.**"
- **FB 里用多重实例**：官方原文 "the timer data is contained in a single data block… This reduces the processing time and data storage… **There is no interaction between the timer data structures in the shared multi-instance DB.**"

### 变量表

| 名称建议 | 数据类型 | 方向/存储区 | 说明 |
|---|---|---|---|
| `延时条件` / `Dly_In` | Bool | I / M / DB | |
| `延时定时` / `T_Dly` | IEC_TIMER | FB→**Static** / FC→全局 DB | 16 字节 |
| `延时设定` / `Dly_PT` | **Time** | DB | 可现场调的整定值 |
| `延时后动作` / `Dly_Out` | Bool | M / Q | |
| `延时已到` / `Dly_Done` | Bool | M | = TON.Q，供多处引用 |
| `延时已走` / `Dly_ET` | Time | M / DB | = TON.ET，做进度显示用 |

### 参数与整定

| 用途 | 建议初值 | 范围 | 依据 |
|---|---|---|---|
| **轴使能后稳定延时** | **300 ms** | **100–500 ms** | 驱动器上电自检、电流环建立、抱闸释放。**有抱闸取 300–500 ms**（抱闸机械释放慢）。竞品 demo 取 50 ms（《整定值》2.3） |
| **定位到位后机械稳定延时** | **300 ms** | **100–500 ms** | 机械振动衰减时间，与转盘直径/悬臂长度/刚性相关。竞品取 300 ms（《整定值》2.3） |
| 抱闸释放/施加延时 | 500 ms | 200–500 ms | 查抱闸铭牌；**无数据取 500 ms**（《整定值》2.3） |
| 回原点超时 | 正常回零时间 × 3，且 ≥ 10 s | — | 回零可能从最远点开始（《整定值》2.3） |
| 气缸动作到位超时 | 正常动作时间 × 2，且 ≥ 1 s | ≥ 1 s | 留气压波动、油污增阻、低温变慢余量（《整定值》2.4） |
| 星→角过渡断开 | 100 ms | 50–100 ms | 接触器灭弧 20–50 ms × 2（《整定值》2.2） |
| 输入去抖 | 10–30 ms | 10–30 ms | 机械触点弹跳（《整定值》2.1）。**优先用硬件输入滤波** |
| 保压 / 烘干 / 固化 | ❌ **不给** | — | **工艺参数，必须问甲方**（《整定值》2.4） |
| **Cat 1 停机延时** | ❌ **绝不在 PLC 里实现** | — | 见下 |

**「定位到位后稳定延时」怎么实测（不要猜）**：在工位放百分表或激光位移传感器，分度到位后看读数稳定到公差带内需要多久，取 **1.5 倍**（《整定值》2.3）。

### 🔴 Cat 1 停机延时绝对不能用标准 PLC 的 TON

IEC 60204-1 的停止类别 1 是「受控停止：停机过程中保留动力完成减速，**停稳后**再断动力」，中间有一个延时。

**这个延时必须由安全侧器件计时**：安全继电器的安全延时输出（如可参数化延时输出），或驱动器自带的 **SS1**。

**理由**：PLC 死循环、CPU 停机、程序被改错时，标准定时器**不会走完，动力就永不切断**。安全功能的实现路径一旦穿过标准 PLC，在 ISO 13849-1 下无法论证 —— 标准 CPU + 标准 I/O ≈ **Category B，上限 PL b**，而急停最低要求 **PLr c**（ISO 13850:2015 **4.1.5.1** 原文："…the minimum required is PLr c or SIL 1"）。

西门子官方《Programming Guideline Safety for SIMATIC S7-1200/1500》§3.7.5 WARNING 原文：
> "…**only fail-safe data or fail-safe signals of F-I/O and of other safety programs (in other F-CPUs) are permitted to be processed in the safety program.**"

> Entry ID **109750255** —— ✅ **已核实为 REAL**（《知识库_核查记录_EntryID与PTO》核查 1.2，证据等级 A：SIOS 条目页 `<h1>` 与西门子自生成 URL slug 互证，官方标题逐字为 *Programming Guideline Safety for SIMATIC S7-1200/1500*，当前主附件为 V1.6）。**抽查已完成，无伪造。**

### 常见坑　⚠️【待老殷审】

- 🔴 **运行中改 PT 无效** —— 官方 Table 7-19："**Changing PT has no effect while the timer runs.**"
  **这是"改了设定值没反应"的头号根因。** 必须**先复位定时器**（`-(RT)-` 或让 IN 断一次）再改。**必须写进整定值调试指引。**
- 🔴 **定时器线圈形式必须是 network 最后一条指令**，因此**取不到 Q/ET**（官方 p.184），要在下一个 network 读 `DB.timer.Q` / `.ET`。
- **PT 传负数** —— "**Negative PT values are set to zero**"，不报错，表现为"立刻就到"。
- **引脚名大小写混了** —— TON 是 `IN`/`PT`/`Q`/`ET`（大写），触点线圈是 `in`/`out`/`operand`（小写）。写错导致导入失败。
- **`ET` 悬空** —— 未接输出必须接 `<OpenCon>`。
- **FB 多实例共用 M 或全局 DB 里的定时器** → 实例间互相干扰。**FB 里放 Static / 多重实例**。
- **`TOF` 当已验证指令用** —— `TOF` / `TP` **未经验证**（《技术底座》2.5 明确只证了 TON）。要用 TOF 的：**当前只可人工编写**，或按上面的 TON 变通法生成。
- **`TONR` 在 LAD 中只有 FBD 盒子形式**（官方）。
- **把延时当"安全停机时间"用** —— 见上，Cat 1 延时绝不在 PLC 里。
- **延时时间填成占位值就交货** —— 每个延时都必须进交付文档整定值表，"已确认"列由现场签字（《整定值》第四节）。

### 上机前必须确认　⚠️【待老殷审】

- [ ] 每个延时的初值都有**依据来源**（公式 / 器件手册 / 现场实测），不是拍脑袋
- [ ] 每个延时都进了交付文档整定值表（七列齐全），"已确认"列由**现场调试人员逐项打勾签字**
- [ ] 工艺类延时（保压/烘干/固化）已由**甲方书面提供**，不是 AI 或工程师猜的
- [ ] **Cat 1 停机延时不在 PLC 程序里**，由安全继电器安全延时输出或驱动器 SS1 实现　【标准依据见 ISO 13849-1 / ISO 13850:2015 4.1.5.1】
- [ ] 调试人员知道**运行中改 PT 无效，要先复位定时器**
- [ ] 若用了 `TOF`：确认是人工编写（未验证指令）
- [ ] FB 内定时器实例在 Static
- [ ] 所有超时都有**报警输出**，不是无声等待

### 可生成性
**⚠️ 部分可生成。**
- **通电延时（TON）**：✅ 可自动生成，有博途导出样板作地面真值。
- **断电延时（TOF）**：🔴 **`TOF` 未经验证，不在白名单** —— 直接用 TOF 的写法**当前只可人工编写**；可自动生成的是上文的 **TON 变通法**（`Contact`+`<Negated>`+`O`+`TON`+`Coil`，全在白名单）。生成时必须向用户说明用的是变通实现。

---

# 二、常用设备

本类 7 条。`multi-pump-rotate` 与 `pid-temp` 为 🔴（依赖计数器 / FB 调用），其余 ✅。

---
