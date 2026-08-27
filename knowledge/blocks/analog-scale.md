---
id: "analog-scale"
title: "模拟量标定"
标题: "模拟量标定"
category: "常用设备"
分类: "常用设备"
keywords: ["模拟量", "标定", "量程", "4-20mA", "转换"]
关键词: ["模拟量", "标定", "量程", "4-20mA", "转换"]
applies_to: ["S7-1200", "S7-1500", "S7-200SMART"]
适用: ["S7-1200", "S7-1500", "S7-200SMART"]
difficulty: "进阶"
难度: "进阶"
generation_status: "full"
可生成性: "full"
generation_mark: "✅"
instructions: ["Convert", "Sub", "Mul", "Div"]
example_requests: ["4-20mA 温度变送器标定：0-200°C 对应 4-20mA，用 NORM_X/SCALE_X 或公式转换。S7-1200。", "压力传感器标定：0-1.0MPa 对应 4-20mA，需考虑工程单位和线性化。"]
review_status: "pending"
source: "知识库_积木库正文_草稿待审.md"
---
## 2.6　模拟量标定

**id** `analog-scale`

### 名称/别名
**中文**：模拟量标定 · 量程转换 · 线性标定 · 工程量换算 · 4-20mA 转换
**英文**：Analog Scaling · Engineering Unit Conversion · NORM_X / SCALE_X · Linear Scaling

### 适用场景
把模拟量输入通道的原始整数值（Int）换算成工程量（Real，如 ℃、bar、m³/h、mm），或反向把工程量换算成模拟量输出值。**每个带模拟量的工程都要有。**

### 梯形图逻辑描述

**标准两步法：归一化 → 标定**

```
Network 1: 原始值转 Real
  Convert([液位原始值 : Int])  →  [原始值_R : Real]

Network 2: 归一化到 0.0 ~ 1.0
  Sub([原始值_R], [原始下限])   →  [分子]
  Sub([原始上限], [原始下限])   →  [分母]
  Div([分子], [分母])           →  [归一值 : Real]

Network 3: 标定到工程量
  Sub([工程上限], [工程下限])   →  [工程跨度]
  Mul([归一值], [工程跨度])     →  [临时]
  Add([临时], [工程下限])       →  [液位工程值 : Real]

Network 4: 量程外裁剪与故障判定
  Lt([液位原始值], [断线阈值])   → SCoil[通道断线]
  Gt([液位原始值], [饱和阈值])   → SCoil[通道饱和]
  Lt([归一值], 0.0)  → Move(0.0) → [归一值]     ← 裁剪
  Gt([归一值], 1.0)  → Move(1.0) → [归一值]
```

`Convert`、`Sub`、`Div`、`Mul`、`Add`、`Move`、`Lt`、`Gt` **全部已实证**（`MCPVerify_FC_LAD.xml` / `_v2.xml`）。

> **也可以用博途自带的 `NORM_X` / `SCALE_X`** —— 但这两个指令**不在《技术底座》白名单**（全项目零实例、未验证）。**生成 XML 时不许用**；人工编写时用它们更简洁。这是「白名单 ≠ 博途能力上限」的典型例子，向用户说明时不要说"博途没有"，要说"我们当前的自动生成不覆盖，人工加更省事"。

### 标准量程对应关系（S7-1200/1500 模拟量通道）

| 信号 | 原始值范围（额定量程） | 说明 |
|---|---|---|
| **4–20 mA** | **0 ~ 27648** | 4 mA → 0；20 mA → 27648。**低于 4 mA（约 < 0）即断线** |
| 0–20 mA | 0 ~ 27648 | **无断线检测能力** —— 这是不该选它的理由 |
| ±10 V | −27648 ~ +27648 | |
| 0–10 V | 0 ~ 27648 | |

> ⚠️ **27648 这个数需按实际模块型号核对**。不同模块/不同配置（额定范围、上溢/下溢区间）取值有差异。核对方法：TIA 里选中模拟量模块 → 属性 → 输入通道 → 测量类型与范围，或查该模块的数据手册。**本条按「需核对确切订货号的数据手册」标注**，与《整定值》对 PTO 频率的处理同规格。

### 变量表

| 名称建议 | 数据类型 | 方向/存储区 | 说明 |
|---|---|---|---|
| `xx原始值` / `AI_Raw` | **Int** | **I**（IW） | 通道原始值 |
| `原始下限` / `Raw_Lo` | Real | DB | 通常 0.0 |
| `原始上限` / `Raw_Hi` | Real | DB | 通常 27648.0（**需核对模块手册**） |
| `工程下限` / `Eng_Lo` | Real | DB | 如 0.0 m |
| `工程上限` / `Eng_Hi` | Real | DB | 如 5.0 m |
| `xx工程值` / `AI_Eng` | **Real** | M / DB | 输出 |
| `归一值` / `AI_Norm` | Real | M / DB（可 Temp） | 0.0~1.0 |
| `通道断线` / `Alm_AI_Wire` | Bool | M / DB | |
| `通道饱和` / `Alm_AI_Sat` | Bool | M / DB | |
| `断线阈值` / `Th_Wire` | Int | DB | 略小于 0 的值（4-20mA 断线时为负） |
| `饱和阈值` / `Th_Sat` | Int | DB | 略大于 27648 |

### 参数与整定

| 参数 | 值 | 依据 |
|---|---|---|
| 原始值上下限 | **查模块手册确认**（常见 0 / 27648） | 模块规格，**不许假设** |
| 工程量上下限 | **来自变送器铭牌 / 甲方** | 变送器量程，必须问 |
| 断线阈值 | 略低于 0（4-20 mA 断线时电流 0 → 原始值为负） | 4-20 mA 的天然断线检测 |
| 滤波（软件平均点数） | 视信号噪声定，常见 4–16 点 | 与采样周期、噪声频率相关 |
| 报警延时 | 3–10 s | 防瞬时波动误报（同 2.5） |

**工程量上下限只能问，不能猜** —— 同一个 4-20 mA 信号可能是 0-5 m 液位、也可能是 0-16 bar 压力。**AI 生成时缺这两个数必须向用户索取，不许假设**（《整定值》第五节给 AI 的填值规则第 1 条）。

### 常见坑　⚠️【待老殷审】

- **Int 直接参与除法** → 整数除法丢小数，标定结果全是台阶。**必须先 `Convert` 到 Real**。
- **除数可能为 0** —— 若 `原始上限 = 原始下限`（参数没填），`Div` 除零。**必须做参数合法性检查**，或把跨度写成常量。
- **不做量程外裁剪** → 负原始值算出负工程量，下游逻辑（比较、显示、PID）行为异常。
- **不做断线检测** → 4-20 mA 断线读 0，被当成"最小值"。见 2.5 的溢流案例，**这是会出事故的**。
- **选 0-20 mA 或 0-10 V 却指望断线检测** → 这两种信号断线时的读数与"真实最小值"无法区分。**要断线检测就必须用 4-20 mA**（或带线路故障诊断的模块）。
- **假设 27648** → 不同模块/配置不同。**查手册**。
- **Real 精度问题** → Real 是 32 位单精度，约 7 位有效数字。大量程 + 高精度需求时用 **LReal**（S7-1500）。
- **类型混用报错**【本机】：
  EN: `Data type '{1}' cannot be converted implicitly into data type '{2}'.`
  EN: `Operator '{1}' is not compatible with the data types of '{2}' and '{3}'.`
  ZH: `编译器信息：类型冲突。` / `数据类型 {1} 未知。`
  🔑 **先查块的 IEC check 属性** —— 同一段代码开/关编译结果不同。
- ⚠️ **一条容易被误判为类型错误的合法写法**：官方 Programming Guideline §3.10.10 明确 SCL 支持**操作数重载**，`Time` 可直接与 `DInt` 加减（`time + dint` → Time 合法）。**但表中有 `time + dint`，没有 `time + int`** —— 用 Int 会报类型错，用 DInt 合法。这个差别很容易踩。
- **优化访问与绝对寻址混用**【本机】：
  EN: `Absolute access to data in blocks with optimized access is not permitted.`（KEY `BL_PARSE_11A5`）
  ZH: `不允许在具有优化访问的块中对数据进行绝对寻址。`
  → 优化访问的 DB 不能用 `%DB1.DBW0` 这种绝对地址，必须用符号名。
- 🔴 **优化/标准混用的隐藏行为**（时序 bug 根源）。官方 PG 原文：
  > "…this is not the case if one of the blocks has the property 'Optimized access' and the other block the property 'Default access'. In this case, all parameters are generally transferred as **copy**… the called block always works with the copied values. During block processing, these values may be changed and they are copied back to the original operand, **after** processing of the block call."

  → **优化与标准混用时参数一律退化为拷贝传递，回写发生在块调用结束之后**。这就是"块内改了值但外面没同步"的根因，而且**编译不报错**。
  相关报错【本机】：EN: `Source and target block have to have the same block access type (optimized access or standard access).`（KEY `ERR_PA_SEM_BlockAccess`）/ ZH: `源块和目标块的块访问方式必须相同（优化访问或标准访问）。`
- **标定公式写在多处** → 改量程时漏改一处。**做成 FC，一处实现多处调用**（但注意 🔴 `<Call>` 当前无已验证 XML 写法，生成时只能内联或告知用户手工建 FC）。

### 上机前必须确认　⚠️【待老殷审】

- [ ] 模块的**原始值量程已查手册确认**（不是照抄 27648）
- [ ] 变送器的**工程量量程来自铭牌或甲方书面确认**
- [ ] 信号类型是 **4-20 mA**（若需断线检测）；若为 0-20mA / 0-10V，断线风险已书面告知甲方
- [ ] **断线检测已实现并实测**（拔线，确认报故障且下游联锁动作）
- [ ] 量程外裁剪已实现，负值/超量程不会传给下游
- [ ] 除零保护已做（参数未填时不会崩）
- [ ] 用**两点法现场校验**过：给已知输入（标准信号源或已知液位/压力），核对工程值读数
- [ ] 精度需求已核对（Real 7 位有效数字是否够；不够改 LReal）
- [ ] 块的**访问类型（优化/标准）在调用链上一致**，避免拷贝传递的时序问题
- [ ] 标定逻辑集中实现，未在多处复制

### 可生成性
**✅ 可自动生成。** `Convert`、`Add`、`Sub`、`Mul`、`Div`、`Move`、`Lt`、`Gt`、`SCoil` 全在白名单且有实证。
⚠️ 注意：**`NORM_X` / `SCALE_X` 不在白名单**（未验证），生成时必须用上面的四则运算展开式；建议同时告知用户「人工用 NORM_X/SCALE_X 更简洁」。

---
