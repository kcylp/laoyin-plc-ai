---
id: "multi-pump-rotate"
title: "多台设备轮换"
标题: "多台设备轮换"
category: "常用设备"
分类: "常用设备"
keywords: ["轮换", "交替", "备用", "主备"]
关键词: ["轮换", "交替", "备用", "主备"]
applies_to: ["S7-1200", "S7-1500", "S7-200SMART"]
适用: ["S7-1200", "S7-1500", "S7-200SMART"]
difficulty: "进阶"
难度: "进阶"
generation_status: "none"
可生成性: "none"
generation_mark: "none"
instructions: ["CTU", "Contact", "Coil"]
example_requests: ["3 台水泵轮换：累计运行时间最少的自动启动，手动轮换时也可指定。S7-1200。", "主泵故障自动切备用泵：运行泵故障信号触发备泵启动，故障泵锁定 5 分钟。"]
review_status: "pending"
source: "知识库_积木库正文_草稿待审.md"
---
## 2.3　多台设备轮换

**id** `multi-pump-rotate`

### 名称/别名
**中文**：多台设备轮换 · 交替运行 · 主备切换 · 轮值 · 均衡运行时间
**英文**：Duty/Standby Rotation · Pump Alternation · Lead-Lag Control · Run-Hour Equalization

### 适用场景
两台或多台同规格设备（水泵、风机、空压机）交替运行，目的是**均衡各台运行小时数**、避免一台长期不动而卡死。常见需求：
- 每启动一次换一台（按启动次数轮换）
- 累计运行时间达到阈值换一台（按运行小时轮换）
- 主机故障自动切备机

### 梯形图逻辑描述（模式，非可生成代码）

```
Network 1: 启动次数计数（轮换依据之一）
  常开[启动请求] → PBox → CTU(CU)，PV = 台数
      CTU.CV → [当前序号]
      CTU.QU → RCoil / 复位 CTU（回绕到 1）

Network 2: 按序号选台
  Eq([当前序号], 1) 串联 常开[启动请求] 串联 常开[1号可用] → 线圈[启1号]
  Eq([当前序号], 2) 串联 常开[启动请求] 串联 常开[2号可用] → 线圈[启2号]
  …

Network 3: 累计运行时间（轮换依据之二）
  常开[1号运行] → TON(IN)，PT = 1 小时 → TON.Q → CTU_1(CU) 累加小时数
  （或用 Add 每秒累加，配合秒脉冲）

Network 4: 故障切备
  常开[1号故障] → SCoil[跳过1号]，并强制 [当前序号] 前进

Network 5: 轮换互锁
  常闭[启2号] 串联 … → 线圈[启1号]   （若工艺要求同一时刻只跑一台）
```

**🔴 关键依赖**：轮换的核心是**计数**（启动次数 / 运行小时），必须用 `CTU`（或 `Add` + 定时器累加变通）。
- 用 `CTU` → **🔴 计数器 XML 侧零实例，当前无已验证写法**
- 用 `Add` + `TON` 累加 → 这条路**全在白名单内**（`Add`、`TON`、`Move`、`Eq` 都已实证），⚠️ **但精度差**（受扫描周期与定时器复位时机影响），且累加变量必须放**保持性 DB**（断电不能丢运行小时）

### 计数器术语（遵《总索引》第四节）

**指令名是 `CTU` / `CTD` / `CTUD`，没有 `CTU_INT` 这个指令。**
计数值类型从**指令名下方的下拉框**选（官方 Table 7-22 脚注："**Select the count value data type from the drop-down list below the instruction name.**"），对应六种结构类型：

| 结构类型 | PV/CV 类型 | 内存 |
|---|---|---|
| **IEC_Counter** | **Int** | 6 字节 |
| IEC_SCounter | SInt | 3 字节 |
| IEC_DCounter | DInt | 12 字节 |
| IEC_UCounter | UInt | 6 字节 |
| IEC_USCounter | USInt | 3 字节 |
| IEC_UDCounter | UDInt | 12 字节 |

**PV 与 CV 必须同型**（S7-1500 另支持 LInt / ULInt）。
在博途里插入 `CTU` 并选 Int 类型后，**自动生成的背景 DB 实例名会带 `CTU_INT` 后缀**（这就是竞品视频里 `FbAutoSeq_CTU_INT [DB10]` 的来源）—— 那是**实例命名**，不是指令名。

### 变量表

| 名称建议 | 数据类型 | 方向/存储区 | 说明 |
|---|---|---|---|
| `启动请求` / `Req_Start` | Bool | M | |
| `当前序号` / `DutyIdx` | **Int** | **保持性 DB** | 轮到第几台；断电必须记住 |
| `台数` / `UnitQty` | Int | DB | 常量参数 |
| `n号可用` / `Unit_n_OK` | Bool | M / I | 无故障 + 手动允许投入 |
| `n号故障` / `Unit_n_Flt` | Bool | I | |
| `启n号` / `Run_Unit_n` | Bool | Q | |
| `n号运行小时` / `Unit_n_Hrs` | **DInt** | **保持性 DB** | 累计运行小时，断电必须保留 |
| `轮换计数` / `C_Duty` | IEC_Counter（或保持性 DB 中的结构） | 见下 | 🔴 |
| `小时计时` / `T_Hour` | IEC_TIMER | FB→Static | 1 小时基准 |

### 参数与整定

| 参数 | 建议初值 | 依据 |
|---|---|---|
| 轮换阈值（按小时） | **视工艺定** | 与设备维保周期、甲方运行制度相关，无通用依据 |
| 轮换阈值（按启动次数） | **视工艺定** | 同上 |
| 备机启动延时（主机故障后） | 视工艺定，通常 3–10 s | 需给主机停稳时间；管路系统还要考虑水锤 |
| 定时器换算基准 | 3600 s = 1 小时 | 算术 |

**所有轮换阈值都是甲方运行管理参数，不是工程参数 —— 必须问，不许猜。**

### 常见坑　⚠️【待老殷审】

- 🔴 **累计运行小时不放保持性存储区** → 每次断电清零，轮换逻辑永远从第一台开始，**均衡的目的完全落空**，而且没人会发现（因为看起来在轮换）。
- 🔴 **计数器背景 DB 不可保持**（官方 p.192 原文）：
  > "When you accept the defaults in the call options dialog… you are automatically assigned an **instance DB which cannot be made retentive**. To make your counter data retentive, you must either use a **global DB** or a **Multi-instance DB**."

  → **默认插入方式生成的计数器背景 DB 无法设为保持性。** 想让计数保持，**必须用全局 DB 或多重实例 DB**。**这条正是本积木最容易踩的坑。**
- 🔴 **无符号计数器计到上限不回绕**（官方原文）：
  > "If the count value is an **unsigned** integer type, you can count down to zero or count up to the range limit. If the count value is a **signed** integer, you can count down to the negative integer limit and count up to the positive integer limit."

  → 选 `USInt` 计到 **255 就停在上限、不回绕**。表现为"计数器卡住了"。这是"计数器不动"的常见根因。
- **计数速率上限 = 所在 OB 的执行频率**（官方："must be executed often enough to detect all transitions of the CU or CD inputs"）。更快的需要 `CTRL_HSC`。
  → 轮换场景速率极低，不受此限；但如果拿这条积木去数高速脉冲，会**漏计**。
- **序号越界不处理** → `当前序号` 加到台数+1 时没有一台被选中，设备全停，且没有报警。**必须回绕并加边界检查**。
- **故障台被跳过后不复位跳过标志** → 故障修好了仍然不投入。
- **轮换时新旧两台同时运行** → 若工艺不允许，必须互锁；若工艺要求"先启新的再停旧的"（不允许断流），必须显式设计重叠时间。**这两种需求相反，必须与甲方确认。**
- **备机长期不动反而卡死** —— 轮换的初衷就是防这个。若采用"故障才切备"策略，必须另加**定期试运行**（例如每周强制跑备机 10 分钟）。
- **"运行小时"用 Int 累计** → Int 上限 32767 小时 ≈ 3.7 年，可能溢出。用 **DInt**。
  相关报错【本机】：EN: `Data type '{1}' cannot be converted implicitly into data type '{2}'.` / ZH: `编译器信息：类型冲突。`
- **同一时刻多台起停造成电网冲击** → 大功率设备需错开启动时间。

### 上机前必须确认　⚠️【待老殷审】

- [ ] `当前序号` 与各台 `运行小时` **在保持性存储区**（**断电重启实测验证数值还在**）
- [ ] 若用计数器：**计数数据在全局 DB 或多重实例 DB**（默认背景 DB 不可保持）
- [ ] 计数值数据类型已选定，且**已确认不会撞上限不回绕**（不用 USInt 数大数）
- [ ] 序号越界已处理并回绕，且越界时有报警
- [ ] 轮换策略已由**甲方确认**：按次数 / 按小时 / 故障才切；阈值多少
- [ ] "同一时刻允许几台运行"已由甲方确认，互锁或重叠逻辑与之匹配
- [ ] 故障台复位后能重新投入（实测：模拟故障 → 切备 → 复位故障 → 确认可再投入）
- [ ] 备机有**定期试运行**机制（若采用故障才切策略）
- [ ] 各台的**热保护/故障信号**都已接入且 NC 接线
- [ ] 大功率设备的启动错开时间已考虑

### 可生成性
**🔴 暂不可自动生成 —— 等 TASK-012A 实证，当前只可人工编写。**
根因：轮换依赖计数器（`CTU` / `CTD` / `CTUD`），而《技术底座》第三节确认计数器在全项目 XML 中**零实例、零验证**。

**可部分交付的替代路径**（诚实告知用户）：若改用 `Add` + `TON` 累加的变通实现（全部指令在白名单内），主体逻辑可生成 ⚠️ —— 但必须同时说明：① 精度受扫描周期影响；② 累加变量必须由用户在保持性 DB 中定义；③ 这不是标准做法，标准做法要等计数器写法实证。

---
