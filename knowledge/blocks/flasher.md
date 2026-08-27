---
id: "flasher"
title: "闪烁/报警灯"
标题: "闪烁/报警灯"
category: "基础逻辑"
分类: "基础逻辑"
keywords: ["闪烁", "闪灯", "报警灯", "警示"]
关键词: ["闪烁", "闪灯", "报警灯", "警示"]
applies_to: ["S7-1200", "S7-1500", "S7-200SMART"]
适用: ["S7-1200", "S7-1500", "S7-200SMART"]
difficulty: "入门"
难度: "入门"
generation_status: "full"
可生成性: "full"
generation_mark: "✅"
instructions: ["TON", "Contact+Negated", "Coil"]
example_requests: ["报警灯闪烁：有报警时灯以 1Hz 闪烁，无报警时常亮。S7-1200。", " Beacon 灯三态：无报警灭、故障快闪(2Hz)、断电常亮。"]
review_status: "pending"
source: "知识库_积木库正文_草稿待审.md"
---
## 1.7　闪烁 / 报警灯

**id** `flasher`

### 名称/别名
**中文**：闪烁 · 闪灯 · 报警灯 · 方波发生 · 秒脉冲
**英文**：Flasher · Blinker · Square Wave Generator · Alarm Lamp

### 适用场景
报警指示灯闪烁、运行状态区分（常亮=运行 / 闪烁=待机 / 快闪=报警）、蜂鸣器间断鸣响。

### 梯形图逻辑描述

**双 TON 互激法（白名单内唯一可生成的做法）**

```
Network 1:  常闭[闪烁输出]  →  TON_1(IN)，PT = 灭时间
Network 2:  常开[TON_1.Q]   →  TON_2(IN)，PT = 亮时间
            并 →  线圈[闪烁输出]   （TON_1.Q 到即点亮）
Network 3:  常开[TON_2.Q]   →  RCoil[闪烁输出]  （亮够就灭，TON_1 重新开始计时）

Network 4:  应用
  常开[有报警] 串联 常开[闪烁输出]  →  线圈[报警灯]
```

**更省事的替代（若 CPU 已组态时钟存储器字节）**：TIA 里 CPU 属性 → 系统和时钟存储器 → 启用时钟存储器字节，可直接得到 0.5 Hz / 1.25 Hz / 2 Hz / 2.5 Hz / 5 Hz / 8 Hz / 10 Hz 的现成方波位。
⚠️ **但时钟存储器是 CPU 组态项，不是梯形图内容** —— 生成程序时若采用，**必须在交付文档里写明要求用户在 CPU 属性里启用哪个字节**，否则程序编译过但灯不闪。

### 变量表

| 名称建议 | 数据类型 | 方向/存储区 | 说明 |
|---|---|---|---|
| `闪烁输出` / `Flash` | Bool | M | 方波位 |
| `闪烁定时1` / `T_FlashOff` | IEC_TIMER | FB→**Static** / FC→全局 DB | 灭相 |
| `闪烁定时2` / `T_FlashOn` | IEC_TIMER | 同上 | 亮相 |
| `有报警` / `Alm_Any` | Bool | M / DB | 见 4.1 |
| `报警灯` / `Lamp_Alm` | Bool | Q | |
| （可选）`时钟位` / `ClkBit` | Bool | M（CPU 时钟存储器字节内） | **需 CPU 组态启用** |

### 参数与整定

| 参数 | 建议初值 | 依据 |
|---|---|---|
| **一般报警闪烁** | **亮 0.5 s / 灭 0.5 s**（1 Hz） | 人眼可辨识闪烁频率 1–3 Hz（《整定值》2.6） |
| **紧急报警闪烁** | **亮 0.2 s / 灭 0.2 s**（2.5 Hz） | 快闪表示更紧急是行业惯例（《整定值》2.6） |
| 蜂鸣器间断 | 视工艺定 | 与现场噪声环境相关，无通用依据 |
| 报警确认后抑制期 | 1–3 s | 防同一故障反复刷屏（《整定值》2.6） |

### 常见坑　⚠️【待老殷审】

- 🔴 **定时器线圈形式必须是网络最后一条指令**，取不到 Q/ET。官方 p.184："The -(TP)-, -(TON)-, -(TOF)-, and -(TONR)- timer coils **must be the last instruction in a LAD network.**" → 用线圈形式就必须在**下一个 network** 读 `DB.timer.Q` / `.ET`。（`-(RT)-` / `-(PT)-` 相反，可放中间。）
  → 本积木**推荐用盒子形式**（`Part Name="TON"`，引脚 `IN`/`PT`/`Q`/`ET`），可在同一 network 取 Q。
- 🔴 **运行中改 PT 无效**。官方 Table 7-19："**Changing PT has no effect while the timer runs.**" 改闪烁频率没反应 → 必须先复位定时器。**这条要写进整定值调试指引。**
- **TON 引脚名大写**（`IN`/`PT`/`Q`/`ET`），触点/线圈引脚名小写（`in`/`out`/`operand`）。**这是最容易写错的地方**（《技术底座》2.5）。
- **未接的输出引脚必须显式接 `OpenCon`**，不能悬空（`ET` 不用也要接）。
- **PT 是 `TIME` 类型**（32 位按 DInt 存毫秒，范围 `T#-24d20h31m23s648ms` ~ `T#24d20h31m23s647ms`）。**"Negative PT values are set to zero"** —— 传负数不报错，直接当 0，表现为"定时器不计时/立刻到"。
- **闪烁位被多处使用还各自加条件** → 多个不同步的闪烁源，指示灯看起来乱闪。**闪烁位只产生一次，全局共用**。
- **FB 里的 TON 实例放 M 或全局 DB** → 多实例串味。**FB 里放 Static**（`MCPVerify_FB_LAD_v3.xml` 注释明确："TON 实例在 FB.Static（TON_TIME）"）；**FC 里** 用 `Scope="LocalVariable"` 或挂全局 DB。
- **✅ 顺带纠正一条流传的错误**：社区流传"FC 里调 IEC 定时器会编译报错"是**错的**。官方手册 p.193 明确 "This option works regardless of where the counter is placed (**OB, FC, or FB**)"。FC 的真实限制是**没有 Static**，只能挂全局 DB，且多次调用共用同一实例。（该错误说法出自内容农场，见《总索引》第五节黑名单。）
- **经典 S7 定时器（S_ODT / SD / S5）不要用** —— 官方 PG §3.4.2："Avoid hardware-dependent memory… **Use the IEC counter and timer in connection with multi-instances instead.**"
- ⚠️ **一条容易误引的官方条文**：PG §5.12.1 "Avoiding of time-processing blocks: TP, TON, TOF" 属 **STEP 7 Safety / F 程序**章节，**只对安全程序成立，不要当通用建议引**。

### 上机前必须确认　⚠️【待老殷审】

- [ ] 若用了 CPU 时钟存储器字节：**交付文档已写明要用户在 CPU 属性里启用**，且现场已启用
- [ ] 闪烁频率现场看过，操作工能分辨"常亮/慢闪/快闪"三种状态
- [ ] TON 的 `ET` 等未用输出已接 `OpenCon`（若为生成的 XML）
- [ ] FB 内的定时器实例在 **Static**
- [ ] 改闪烁 PT 时知道要**先复位定时器**（写进调试指引）
- [ ] 报警灯/蜂鸣器的**断线自检**已考虑（灯坏了操作工看不出有报警 —— 若为关键指示，需按周期自检点亮）

### 可生成性
**✅ 可自动生成。** `TON`×2、`Contact`+`<Negated>`、`Coil`、`RCoil` 全在白名单，TON 写法有博途导出样板作地面真值。

---
