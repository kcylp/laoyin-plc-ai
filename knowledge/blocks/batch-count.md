---
id: "batch-count"
title: "产量计数"
标题: "产量计数"
category: "流程控制"
分类: "流程控制"
keywords: ["计数", "产量", "批次"]
关键词: ["计数", "产量", "批次"]
applies_to: ["S7-1200", "S7-1500", "S7-200SMART"]
适用: ["S7-1200", "S7-1500", "S7-200SMART"]
difficulty: "进阶"
难度: "进阶"
generation_status: "none"
可生成性: "none"
generation_mark: "none"
instructions: ["CTU", "Contact"]
example_requests: ["班产量计数：每来一个工件脉冲 CTU 计数，班次切换时 CTD 清零。S7-1200。", "批次计数：设定目标数量，CTU 到 PV 触发报警并停止线体。"]
review_status: "pending"
source: "知识库_积木库正文_草稿待审.md"
---
## 3.4　产量计数

**id** `batch-count`

### 名称/别名
**中文**：产量计数 · 计数 · 批次计数 · 累计产量 · 班产统计 · 计件
**英文**：Production Counter · Batch Count · Piece Counter · Throughput Counting

### 适用场景
统计产量（总产量、班产量、批次数）、按批次数量自动停机、废品计数、循环次数统计。

### 计数器术语（遵《总索引》第四节，重述一遍以免误用）

**指令名是 `CTU`（加计数）/ `CTD`（减计数）/ `CTUD`（加减计数）。没有 `CTU_INT` 这个指令。**

计数值类型从**指令名下方的下拉框**选。官方 Table 7-22 脚注原文：
> "**Select the count value data type from the drop-down list below the instruction name.**"

| 结构类型 | PV/CV 类型 | 内存 |
|---|---|---|
| **IEC_Counter** | **Int** | 6 字节 |
| IEC_SCounter | SInt | 3 字节 |
| IEC_DCounter | DInt | 12 字节 |
| IEC_UCounter | UInt | 6 字节 |
| IEC_USCounter | USInt | 3 字节 |
| IEC_UDCounter | UDInt | 12 字节 |

**PV 与 CV 必须同型**（S7-1500 另支持 LInt / ULInt）。

**在博途里插入 `CTU` 并选 Int 类型后，自动生成的背景 DB 实例名会带 `CTU_INT` 后缀** —— 竞品视频里的 `FbAutoSeq_CTU_INT [DB10]` 就是这个。那是**博途的实例命名行为**，不是指令名。
→ 生成 XML 时**指令名写 `CTU`**，类型走模板参数。**具体写法等 TASK-012A 实证**（计数器目前是 🔴 零实例）。

### 梯形图逻辑描述（模式，非可生成代码）

```
Network 1: 计数脉冲（必须用边沿，否则一个工件数一堆）
  常开[出料检测] → PBox → 线圈[计数脉冲]
  （或：Eq([步号], 60) 串联 常开[步内已驻留] → PBox → 线圈[计数脉冲]）

Network 2: 总产量（CTU）
  常开[计数脉冲]  →  CTU(CU)
      CTU.CV  →  [总产量]
      PV = [批次目标]
      CTU.QU  →  线圈[批次完成]

Network 3: 复位（人工，且要留痕）
  常开[产量复位按钮] 串联 常开[手动允许] → PBox → CTU(R)
      并 → Move([总产量]) → [上次班产存档]

Network 4: 批次完成 → 停机
  常开[批次完成]  →  RCoil[允许运行]，SCoil[批次完成提示]

Network 5: 废品计数（独立计数器）
  常开[废品判定] → PBox → CTU_NG(CU) → [废品数]

Network 6: 合格率（可选）
  Sub([总产量], [废品数]) → [合格数]
  Div → 合格率（注意先 Convert 到 Real，见 2.6）
```

**不用计数器的白名单变通做法**（⚠️ 可生成但非标准）：
```
常开[计数脉冲]  →  Add([总产量], 1) → [总产量]
Ge([总产量], [批次目标])  →  线圈[批次完成]
```
`Add` / `Ge` / `Move` **全在白名单且有实证**。但这不是标准做法，且**累加变量必须由用户放保持性 DB**。

### 变量表

| 名称建议 | 数据类型 | 方向/存储区 | 说明 |
|---|---|---|---|
| `出料检测` / `PE_Out` | Bool | I | 光电/接近开关 |
| `计数脉冲` / `Cnt_Pulse` | Bool | M | 边沿后的单周期脉冲 |
| `计数沿` / `Cnt_P` | Bool | **Static** / M | 边沿 M_BIT，独占 |
| `总产量` / `Qty_Total` | **DInt** | **保持性 DB** | 断电必须保留 |
| `班产量` / `Qty_Shift` | DInt | 保持性 DB | |
| `废品数` / `Qty_NG` | DInt | 保持性 DB | |
| `批次目标` / `Qty_Target` | DInt | DB（可来自配方） | |
| `批次完成` / `Batch_Done` | Bool | M / DB | |
| `产量计数器` / `C_Qty` | IEC_DCounter（或**全局 DB / 多重实例**中的结构） | 见下 🔴 | **不能用默认背景 DB**（不可保持） |
| `上次班产存档` / `Qty_LastShift` | DInt | 保持性 DB | 复位时留痕 |

### 参数与整定

| 参数 | 值 | 依据 |
|---|---|---|
| **批次目标数量** | **视工艺定** —— 问甲方 | 生产计划参数 |
| 计数数据类型 | **DInt / UDInt**（大产量）；Int 上限 32767 容易溢出 | 算术：Int 32767 件、DInt 约 21 亿件 |
| 计数脉冲最小间隔 | **≥ 所在 OB 的执行周期** | 官方：计数速率上限 = OB 执行频率（见下） |
| 出料检测去抖 | 0–10 ms（电子输出） | 《整定值》2.1 |
| 班次切换时刻 | 视甲方作息定 | 业务参数 |

### 常见坑　⚠️【待老殷审】

- 🔴 **计数器背景 DB 不可保持**（官方 p.192 原文）：
  > "When you accept the defaults in the call options dialog… you are automatically assigned an **instance DB which cannot be made retentive**. To make your counter data retentive, you must either use a **global DB** or a **Multi-instance DB**."

  → **接受默认插入方式生成的背景 DB 无法设为保持性 → 断电产量清零。**
  **这是本积木的头号坑。** 必须用 **全局 DB 或多重实例 DB**。
- 🔴 **无符号计数器计到上限不回绕**（官方原文）：
  > "If the count value is an **unsigned** integer type, you can count down to zero or count up to the range limit. If the count value is a **signed** integer, you can count down to the negative integer limit and count up to the positive integer limit."

  → 选 `USInt` 计到 **255 停在上限、不回绕**；`UInt` 停在 65535。表现为"**计数器卡住了、产量不涨了**"。这是"计数器不动"的常见根因。
- 🔴 **计数速率上限 = 所在 OB 的执行频率**。官方原文：计数器"must be executed often enough to detect all transitions of the CU or CD inputs"。
  → **高速计数（每秒几十件以上，或脉冲窄于扫描周期）会漏计**，必须用 **`CTRL_HSC`**（高速计数器）。
  **这是"产量老是比实际少"的根因**，而且很难发现，因为少得不多。
- **计数不用边沿** → 光电被遮挡期间每个扫描周期都加 1，一个工件数出几十件。**必须用 `PBox`（或 CTU 的 CU 引脚天生按沿计数 —— 但输入信号本身若来自持续为真的条件，仍需边沿）。**
- **边沿 M_BIT 复用 / 在 FB 里用 M 位** → 见 1.6，**FB 里放 Static**。
- **Int 类型累计大产量溢出** → 32767 后翻负数。用 **DInt**。
  相关报错【本机】：EN: `Data type '{1}' cannot be converted implicitly into data type '{2}'.` / ZH: `编译器信息：类型冲突。`
- **产量复位不留痕、不需权限** → 操作工随手清零，班产统计失真且无法追溯。**复位应留档（存上次值 + 时间戳）+ 需方式/权限判断**。
- **复位不用边沿** → 按住复位键期间计数器一直被复位，看起来"计数器坏了"。
- **只有总产量，没有班产/批次** → 甲方要的其实是班产。**先问清要统计哪几个维度。**
- **废品与合格品共用一个计数器** → 数据失真。**分开计数**。
- **计数点位置选错** → 在工位入口计数则含未加工完的，在出口计数才是成品。**计数点必须与"什么算一件成品"的定义一致，问甲方。**
- **合格率计算用整数除法** → 结果永远是 0 或 1。**必须先 `Convert` 到 Real**（见 2.6）。
- ⚠️ **顺带纠正一条流传的错误**：社区流传"FC 里调 IEC 定时器/计数器会编译报错"是**错的**。官方手册 p.193 明确 "This option works regardless of where the counter is placed (**OB, FC, or FB**)" —— 用**全局 DB** 里的 IEC 结构：插入时在 Call options 点 Cancel，再在指令上方手输结构名。FC 的真实限制是**没有 Static**。（该错说法出自内容农场，见《总索引》第五节黑名单。）

### 上机前必须确认　⚠️【待老殷审】

- [ ] 计数数据在**全局 DB 或多重实例 DB**，且**设为保持性**（**断电重启实测：产量还在**）
- [ ] 计数数据类型是 **DInt / UDInt**，已核算不会在设备寿命内溢出
- [ ] 若用无符号类型：已确认**不会撞上限**（撞了不回绕，表现为卡住）
- [ ] 计数速率在**所在 OB 的执行频率**之内（实测：跑满产速对比人工数，确认不漏计）；超出则改用 `CTRL_HSC`
- [ ] 计数用**边沿触发**，实测一个工件只加 1（**连过十件人工核对**）
- [ ] 边沿 M_BIT 独占，FB 内放 Static
- [ ] **计数点位置与"什么算一件成品"的定义一致**，已由甲方确认
- [ ] 复位**需权限/方式判断**、**用边沿**、**留档上次值**
- [ ] 统计维度（总产/班产/批次/废品）已由甲方确认，逐项实现
- [ ] 废品与合格品**分开计数**
- [ ] 批次完成后的行为（停机/报警/继续）已由甲方确认
- [ ] 合格率等派生计算已 `Convert` 到 Real，无整数除法

### 可生成性
**🔴 暂不可自动生成 —— 等 TASK-012A 实证，当前只可人工编写。**
根因：`CTU` / `CTD` / `CTUD` 在全项目 XML 中**零实例、零验证**（《技术底座》第三节）。指令名、`Instance` 挂载方式、类型模板参数写法全部未知。

**可交付的部分（诚实话术）**：
> 您的需求涉及计数器（CTU），当前版本还不能自动生成这类梯形图。
>
> 我可以为您做的：① 生成除计数器本身之外的全部逻辑（计数脉冲的边沿检测、批次比较、完成停机、复位许可、废品分类、合格率计算）；② 给出计数器部分的**详细手工添加指引**（用 CTU、类型下拉框选 DInt、**计数数据必须放全局 DB 或多重实例 DB 才能保持**、PV 接批次目标）；③ 生成 I/O 分配表和交付文档。
>
> 也可以用「Add 累加」的变通实现（全部指令已验证，可直接生成），代价是不是标准做法、且累加变量需您在保持性 DB 中定义。您选哪种？

---

# 四、报警与安全

本类 3 条，**每个工程都要有**。
`safety-interlock` 的**逻辑部分** ✅ 可生成，但**安全功能本身绝不由本程序承担** —— 这一节必须读完再写代码。

---
