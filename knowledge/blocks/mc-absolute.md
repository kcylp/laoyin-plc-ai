---
id: "mc-absolute"
title: "绝对定位"
标题: "绝对定位"
category: "运动控制"
分类: "运动控制"
keywords: ["MC_MoveAbsolute", "绝对定位", "位置"]
关键词: ["MC_MoveAbsolute", "绝对定位", "位置"]
applies_to: ["S7-1500"]
适用: ["S7-1500"]
difficulty: "高级"
难度: "高级"
generation_status: "none"
可生成性: "none"
generation_mark: "none"
instructions: ["MC_MoveAbsolute"]
example_requests: ["绝对定位到 500mm 位置：直接指定目标位置，轴自行计算最短路径。S7-1500。", "多位置表：HMI 选择目标位置号，程序查表获取绝对坐标并执行。"]
review_status: "pending"
source: "知识库_积木库正文_草稿待审.md"
---
## 5.5　绝对定位

**id** `mc-absolute`
**用到的指令** `MC_MoveAbsolute`

### 名称/别名
**中文**：绝对定位 · 定位到指定位置 · 工位定位 · 绝对移动
**英文**：Absolute Positioning · MC_MoveAbsolute · Position Move

### 适用场景
移动到**绝对坐标**（工位 3、位置 125.4 mm）。相比相对定位，**误差不累积**，是分度盘不整除时的推荐解法（《整定值》1.2 解法 2）。

### 梯形图逻辑描述

```
Network 1: 绝对定位许可（✅ 可生成）—— ⚠️ 必须串「已回零」
  常开[允许发运动指令] 串联 常开[已回零]        ← 【必须】绝对定位要求已回零
      串联 常开[全部气缸原位] 串联 常闭[有报警]
      串联 常开[安全状态正常]
      →  线圈[允许绝对定位]

Network 2: 目标位置计算（✅ 可生成 —— 这是"误差不累积"的关键）
  Mul([目标工位号], [每工位距离]) → [目标位置]
      其中 [每工位距离] = PPR_out ÷ 工位数（浮点，不必整除）

Network 3: 目标位置合法性检查（✅ 可生成，必须有）
  Ge([目标位置], [位置下限]) 串联 Le([目标位置], [位置上限])
      →  线圈[目标位置合法]
  常闭[目标位置合法]  →  SCoil[Alm_PosRange]

Network 4: 触发（✅ 可生成，保持 Execute 到 Done）
  Eq([步号], 20) 串联 常开[步内已驻留]
      串联 常开[允许绝对定位] 串联 常开[目标位置合法]
      →  SCoil[定位Execute]
  常开[定位Done] 并联 常开[定位Aborted] 并联 常开[定位Error]
      →  RCoil[定位Execute]

Network 5: 【🔴 手工添加】MC_MoveAbsolute
  Execute   ← [定位Execute]
  Axis      ← 工艺对象
  Position  ← [目标位置]      ← Execute 上升沿锁存
  Velocity  ← [定位速度]      ← ⚠️ 平台默认值不同
  Direction ← 见下（枚举因平台而异）
  输出：Done / Busy / CommandAborted / Error / ErrorID (/ErrorInfo：仅 1200)

Network 6-8: Done 捕获 / 稳定延时 / 超时（同 5.4，✅ 可生成）
```

### 🔴 回零要求：只有绝对定位要

| 指令 | 要求已回零？ |
|---|---|
| **MC_MoveAbsolute** | ✅ **要**（两平台 Requirements 都明确列 "The axis is homed"） |
| MC_MoveRelative | ❌ 不要 |

**S7-1200 未回零时发绝对定位** → **`16#8204` / `16#0001`**，分类是 **"Operating error WITHOUT axis stop"**，官方定义：
> "**If the axis is in motion, the motion is continued.** The errors are only indicated in [the Motion Control instruction]."

🔴 **注意：报错了但运动继续。** 这与限位类错误（with axis stop）是两回事。
**→ 所以「已回零」必须在 PLC 侧做硬联锁，不能指望指令自己拦住。**

**S7-1500 未回零** → technology alarm（**编号待核** —— 定义在《S7-1500/S7-1500T Motion Control alarms and error IDs》分册，未下载。**不推断编号**）。

### 🔴 `Done` 的判据：两平台最实质的差异

| 配置 | `Done` 什么时候置位 |
|---|---|
| **S7-1200 + PTO** | **没有定位监视** —— PTO 是开环发脉冲，无位置闭环判据。**Done 只跟随插补完成** |
| **S7-1200 + PROFIdrive/模拟量** | 定位窗口 + tolerance time + **MinDwellTime** 全满足；超时 → `16#800F`/`16#0045`，**Remove enable** |
| **S7-1500** | **始终**有定位监视：到位 + **MinDwellTime**；超时 → technology alarm **541**，**remove enable** |

🔴 **工程要点一：S7-1500 上定位窗口超时不是"报个错继续跑"，是直接掉使能。**

🔴 **工程要点二（更重要）：S7-1200 + PTO（也就是竞品那个 demo 的配置）根本没有定位监视** —— `Done` 置位只说明"**脉冲发完了**"，**不说明轴真的到位了**。开环步进丢步时，**PLC 不知道，`Done` 照样置位**。

**→ 这一条必须写进《上机前必须现场确认》**：PTO 开环配置下，**位置精度只能靠机械和现场实测保证，程序层面无从校验**。

### `Direction` 参数：只在 modulo 启用时才有意义

| 平台 | 枚举 |
|---|---|
| **S7-1200** | `0` = 用 Velocity 符号定方向 / `1` = 正向 / `2` = 负向 / `3` = 最短路径。**PTO 轴忽略此参数** |
| **S7-1500** | **只有 `1/2/3`，没有 `0`** |

**对转盘类设备**：`3`（**最短路径**）配合 modulo 是常见做法 —— 从工位 5 到工位 1，走最短的那边而不是绕一圈。
**但必须先在工艺对象里启用 modulo**，否则这个参数被无视。

`Velocity = 0`：**S7-1500 明确 `Not permitted`**；S7-1200 通常报错。

### 变量表

| 名称建议 | 数据类型 | 方向/存储区 | 说明 |
|---|---|---|---|
| `定位Execute` / `Abs_Exec` | Bool | M | 保持到 Done |
| `MC_MoveAbsolute实例` / `Inst_Abs` | MC_MoveAbsolute | 背景 DB | 🔴 手工，**独立实例** |
| `目标工位号` / `Target_Stn` | Int | DB | |
| `每工位距离` / `Stn_Pitch` | **Real / LReal** | DB | = PPR_out ÷ N（浮点，**不必整除**） |
| `目标位置` / `Target_Pos` | Real / LReal | DB | 计算所得 |
| `位置上限/下限` / `Pos_Hi/Lo` | Real / LReal | DB | 合法性检查用 |
| `定位速度` / `Abs_Vel` | Real / LReal | DB | ⚠️ 平台默认值不同 |
| `方向` / `Abs_Dir` | Int | DB | **1200: 0/1/2/3；1500: 1/2/3** |
| `已回零` / `Homed` | Bool | M / DB | **硬联锁条件，不放保持区** |
| `Alm_PosRange` | Bool | DB | 目标位置越界 |

### 参数与整定

| 参数 | 建议初值 | 依据 |
|---|---|---|
| **每工位距离** | `PPR_out ÷ N`（浮点） | 《整定值》1.2 解法 2：**用绝对定位时不必整除，误差不累积** |
| 定位速度 | `min(PTO上限, 电机可用转速) × 0.5` | 《整定值》1.3。同 5.4 |
| 加减速时间 | 中等惯量转盘 **300–800 ms** | 《整定值》1.5。同 5.4 |
| 到位稳定延时 | **300 ms**（100–500 ms） | 机械振动衰减，百分表实测 × 1.5（《整定值》2.3） |
| 位置上下限 | **视机械定** —— 必须与工艺对象的软限位一致 | 机械参数 |
| `Direction` | 转盘 + modulo 已启用 → **`3`（最短路径）**；否则视工艺定 | 常见做法 |
| 定位超时 | 正常定位时间 × 2 | 《整定值》2.5 |

### 常见坑　⚠️【待老殷审】

- 🔴 **未回零就发绝对定位** → S7-1200 报 **`16#8204`/`16#0001`**，但分类是 **"WITHOUT axis stop"** —— **报错了运动继续**。
  **→ 「已回零」必须在 PLC 侧硬联锁，不能靠指令自己拦。**
- 🔴 **S7-1200 + PTO 下把 `Done` 当"真到位"** → **PTO 没有定位监视**，Done 只说明脉冲发完。**开环丢步时 PLC 不知道，Done 照样置位。**
  **这是竞品 demo 那种配置的根本局限，必须书面告知客户。**
- 🔴 **S7-1500 上定位窗口超时会掉使能**（technology alarm **541** → remove enable），不是"报个错继续跑"。要有相应的报警与恢复流程。
- 🔴 **`Direction=0` 搬到 S7-1500** → **1500 没有 0**。
- 🔴 **指望 `Direction=3`（最短路径）但没在工艺对象里启用 modulo** → **参数被无视**，可能绕远路或走错方向。
- 🔴 **PTO 轴上设 `Direction`** → **PTO 轴忽略此参数**（1200）。以为设了最短路径，其实没生效。
- **`Velocity = 0`** → S7-1500 明确 `Not permitted`；1200 通常报错。
- **目标位置不做范围检查** → 算错的工位号导致超出行程，撞机或触发限位。**必须 `Ge`/`Le` 检查。**
- **`已回零` 放保持区** → 断电期间机械被推动，上电后仍认为已回零 → **绝对定位撞机**。
- **参数在 Execute 上升沿锁存**（通用④）→ 改了 Position 没给新沿，走的还是老位置。
- **`Done` 轮询漏采**（通用⑤a）→ 保持 Execute 到 Done，或边沿捕获。
- **新作业顶掉旧作业**（通用②）→ 无队列。定位途中抢发新指令 → 前一个 `CommandAborted`。
- **同一实例共用** → 通用⑥。
- **报警不监视 `MC_Power.Error`** → 通用⑤(c)：**软限位错误只在 MC_Power 上显示**。
- **`ErrorInfo` 跨平台照抄** → S7-1500 无此输出。
- **软/硬限位的行为没搞清**（S7-1200 完整，S7-1500 待核）：

| ErrorID | 含义 | 错误反应 |
|---|---|---|
| `16#8001` / `16#8002` | 软限位下限/上限触发 | 默认 **`-`（不掉使能）**；只有 ErrorInfo `16#0010`「以急停减速度**越过**」才 Remove enable |
| `16#8003` / `16#8004` | 硬限位下限/上限触发 | 一律**急停减速度**停车；反应按驱动类型分叉：**PTO → 急停斜坡；PROFIdrive/模拟量 → 掉使能** |
| `16#800E` / `16#0042` | 撞硬限位后朝**禁止方向**发指令 | Remove enable |

  两者都需 **`MC_Reset`** 确认后**反向**退出（见 5.7）。
  限位属 "Operating error **WITH** axis stop"，官方定义："The errors are indicated in **the error-triggering Motion Control instruction and in the Motion Control instruction "MC_Power"**."

### 上机前必须确认　⚠️【待老殷审】

- [ ] **「已回零」是绝对定位的硬联锁**（实测：上电不回零发绝对定位，确认被 PLC 拦住，**不是靠指令报错**）
- [ ] `已回零` **不在保持区**
- [ ] **若为 S7-1200 + PTO**：已**书面告知客户**「`Done` 只表示脉冲发完，不表示真到位；开环丢步 PLC 无从察觉；位置精度靠机械与现场实测保证」
- [ ] **若为 S7-1500**：定位窗口超时会**掉使能**（alarm 541），报警与恢复流程已设计并实测
- [ ] 目标位置**范围检查已实现**（试输入越界工位号，确认被拒 + 报警）
- [ ] 位置上下限与**工艺对象的软限位一致**
- [ ] `Direction` 取值与**平台**匹配（1500 无 0），且若用 `3` 则**modulo 已在工艺对象里启用**（实测最短路径确实生效）
- [ ] 若为 **PTO 轴**：已知 `Direction` **被忽略**，逻辑不依赖它
- [ ] `Execute` 保持到 Done，或 Done 用边沿捕获
- [ ] 定位精度已用**百分表/量具在各工位逐一实测**（这是 PTO 开环下唯一的验证手段）
- [ ] 报警逻辑同时监视 `MC_Power.Error`（软限位错误只在那里显示）
- [ ] 软/硬限位行为已实测（各方向都撞一次，确认停车方式与恢复流程）
- [ ] 使用**独立实例**
- [ ] 平台差异已核对（Real/LReal、ErrorInfo、Direction 枚举、Velocity 默认值、Done 判据）

### 可生成性
**🔴 暂不可自动生成 —— 等 TASK-012A 实证，当前只可人工编写。**
✅ **可生成的部分**：许可与"已回零"硬联锁、**目标位置计算**（`Mul`/`Add`，浮点，误差不累积）、**位置范围检查**（`Ge`/`Le`）、Execute 置复位、Done/Aborted/Error 边沿捕获、稳定延时、定位超时。

---
