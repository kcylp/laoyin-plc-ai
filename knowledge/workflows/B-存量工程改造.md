---
id: "workflow-b"
workflow_id: "B"
title: "存量工程改造"
标题: "存量工程改造"
type: "workflow"
review_status: "approved"
source: "知识库_工作流B_存量工程改造作战手册.md"
---
# 存量工程改造作战手册（工作流 B）

**适用** 客户已有一个能跑的博途工程，要在上面加功能 / 改逻辑 / 补块
**执行者** AI（老殷工控PLC助手）
**版本** v1 · **日期** 2026-08-23 · **出具** ARCHITECT / Fable 5
**状态** 【草稿，待老殷审】

**证据等级构成**（定义见《知识库_总索引》第三节）
| 等级 | 本文中的内容 |
|---|---|
| 🥇 实证 | 全部报错原文（本机 TIA V21 卫星资源 DLL，标注 DLL/KEY）；产品侧 API 与 MCP 工具名（源码交接包实读）；XSD 与导入器行为 |
| 🥈 官方文档 | `ImportOptions.Override` 的先删后建语义、多语言 culture 要求（TIA Portal Openness 手册） |
| 🥉 通用工程实践 | 改动最小化原则、基线快照纪律、只增不改的块命名策略 —— 无单一权威出处，标注为**惯例** |
| 未证实 | 明确标注在正文，不许当结论用 |

---

## 这份手册解决什么问题

工作流 A（从零新建）最坏的结果是"生成的工程不好用，重来一遍"。**工作流 B 最坏的结果是把客户一条正在生产的线搞停。** 这是两个完全不同量级的风险。

存量工程里有三样东西是 AI 看不见但一定会被它踩到的：

1. **别人写的逻辑**——你新加的块可能和它抢同一个输出、同一个 M 位、同一个块号；
2. **接口契约**——改一个 FB 的形参，所有调用方连带背景 DB 一起崩；
3. **安全程序**——F 块和标准块在博途里是两个世界，混着碰就是人身安全问题。

所以本工作流的核心纪律只有一句：**先读后写，读不全就不写。**

---

## 阶段 0 · 接活前自检（任一项不过就停下来问用户）

| # | 检查 | 手段 | 不过怎么办 |
|---|---|---|---|
| 0.1 | 博途已连接、已挂接到目标工程 | `GET /api/tia/mcp/status` | 引导"连接博途"；连不上走一键环境诊断（TASK-004） |
| 0.2 | 工程里**确实已有程序块** | `GET /api/tia/mcp/software-tree` → `blocks` 非空 | 空工程 → **改走工作流 A**，并明确告诉用户"这是空工程，按新建流程做" |
| 0.3 | 目标 CPU 型号 / 订货号 / 固件版本 | 软件树 + `GetDeviceInfo` | 必须读到真值，**不许沿用上一个工程的记忆** |
| 0.4 | 工程里是否存在**安全程序 / F 块** | 软件树里的 F 块组、`GetBlocksWithHierarchy` | 有 → 见阶段 3.4，**一律不碰**，只在报告里声明边界 |
| 0.5 | 目标块是否**专有技术保护（know-how protection）** | 试导出一次即知 | 保护块**导不出也改不了**，如实告知用户需要密码，或改为新增块旁挂 |
| 0.6 | 工程里是否有**同名块** | 软件树按名去重 | 产品侧会直接拒绝导出（见阶段 1.3），必须先让用户消歧 |
| 0.7 | 客户是否已有**改造前的工程备份** | 直接问 | **没有就先做**，见阶段 1.4。这一条不能省 |

**0.4 和 0.7 是本工作流最容易被跳过、代价最大的两条。**

---

## 阶段 1 · 先读后写：把现状导出来（本工作流的地基）

**纪律：这一阶段一次写操作都不许发生。** 全部是读，产出是一套"改造前基线"文件。

### 1.1 三件套必读（顺序不能反）

| 顺序 | 读什么 | 产品通道 | 底层 MCP 工具 |
|---|---|---|---|
| ① | **软件树**（块清单/类型/语言/分组） | `GET /api/tia/mcp/software-tree` | `GetSoftwareTree`（`softwarePath: 'PLC_1'`） |
| ② | **PLC 变量表**（名/地址/类型/注释） | 硬件面板 →「变量表列表」→ `POST /api/tia/mcp/tag-tables` | `GetPlcTagTables` |
| ③ | **目标块与其邻居的源码** | 左树点块 →「解读」→ 右侧上下文面板 →「导出 S7DCL」 | `DescribeBlockLogic` + `ExportBlocksAsDocuments` |

### 1.2 需要更深时的补充读（走通用工具入口 `POST /api/tia/mcp/call`）

| 想知道 | 工具 | 备注 |
|---|---|---|
| 块的分组层级（改造后必须原位放回） | `GetBlocksWithHierarchy` | 分组路径错了会导入失败，见 3.5 |
| **谁调用了这个块** | `GetCrossReferences` | 工具描述自称 best-effort，**拿不到就必须回退到人工 F11 交叉引用**，不许假设"没人调用" |
| 工艺对象清单（轴/凸轮） | `GetTechnologyObjects` | 改运动控制前必读 |
| UDT / PLC 数据类型 | `GetTypes` / `GetTypeInfo` | 改 DB 结构前必读 |
| 已有外部源（SCL/STL 文本块） | `GetPlcExternalSources` | 这些块的改法与 XML 路线不同 |
| 现场调试留下的监控表 | `GetPlcWatchTables` / `ExportPlcWatchTable` | 里面往往藏着"上一个工程师关心什么" |
| 离线程序与真机运行程序的差异 | `CompareSoftwareToOnline` | 需先 `GoOnline`；**开工前值得跑一次**——如果离线≠在线，说明现场有人直接改过真机 |

⚠️ **`POST /api/tia/mcp/call` 有危险名闸门**：工具名命中 `download|delete|remove|force|stop|reset`（不区分大小写）时必须显式传 `confirmed:true` 才放行。**读现状阶段一个都不该命中**——如果命中了，说明你选错了工具。

### 1.3 两个真实的导出障碍（会当场卡住，要提前说）

**① 专有技术保护块导不出**【本机 V21 · BlockLogic · `Openness_Fbk_BlockLanguageNotSupported`】
> EN: `The block '{0}' is know-how-protected and cannot be exported.`
> ZH: `块“{0}”设有专有技术保护，无法导出。`

⚠️ 顺带一个匹配陷阱：这条的 **KEY 名（BlockLanguageNotSupported）与消息内容（know-how protected）完全不对应**。做规则匹配时**不要靠 KEY 猜语义**，只信 EN/ZH 文本。（同类前例：《LAD 陷阱与编译错误原文》记录的 `Atttibute` 笔误。）

**② 同名块导出会被产品直接拒绝**（🥇 源码实读，`routes/tia-mcp.js` 的 `/export-s7dcl`）
软件树里出现多个同名块时，导出接口返回 **409** 并给出：
> `检测到 N 个同名块"<名>"，批量导出工具无法按组路径唯一定位，已拒绝导出以避免下载错误内容`

**这是产品有意的保护，不是 bug。** 遇到就让用户先改名或指明分组，**绝不允许"随便挑一个导出"**——挑错了会拿着 A 块的内容去改 B 块。

**③ 导出需要工程离线**（🥈 官方，见 `TraceTagCause` 工具说明原文）
> "block export needs the project OFFLINE in TIA — Openness cannot export blocks while it is connected online to the PLC."

即：先 `GoOnline` 做 `CompareSoftwareToOnline`、再 `GoOffline` 做导出，**顺序不能颠倒**。

### 1.4 基线快照：真正的回滚路径（🥉 惯例，本项目强制）

产品的写入历史（`tia_write_history`）只能回滚**单个块**。工程级的结构性改动（新增块、改分组、改变量表）**回不了**。

所以改造前必须留一份工程副本：

```
POST /api/tia/mcp/call
{ "name": "SaveAsProject", "args": { ... 新工程名，建议带日期后缀 ... } }
```

**命名惯例**：`<原工程名>_改造前_20260823`。存好路径，写进交付文档的"回滚路径"一节。

**这一步做完，才允许进入阶段 2。** 没有基线快照就动客户工程，是本工作流唯一的红线级违规。

---

## 阶段 2 · 理解现状，产出"基线表"给用户确认

导出来不等于看懂了。这一阶段的产物是一张**给人看的表**，必须让用户确认后才动手。

### 2.1 基线表最少四张

| 表 | 内容 | 来源 |
|---|---|---|
| **块清单** | 块名 / 类型 / 语言 / 分组路径 / 块号 / 谁调用它 | 软件树 + `GetCrossReferences` |
| **地址占用图** | 已用的 I / Q / M / DB，以及**空闲区间** | 变量表 + 解读结果 |
| **接口契约** | 要改的每个 FB/FC 的 IN/OUT/INOUT/STAT 逐项 | `DescribeBlockLogic` + 导出的 S7DCL |
| **不可碰清单** | F 块、保护块、外部源块、被多处调用的公共块 | 阶段 0.4/0.5 + 交叉引用 |

### 2.2 必做的三项自查（编译器不管，我们管）

**① 双线圈自查（最重要）**
本次要写的每一个输出（Q / M / DB 位），先在**全工程**范围内查它是否已被别处写过。根因见《LAD 陷阱与编译错误原文》3.2：TIA 对双线圈**零警告**，同一周期后写覆盖先写，前面那段逻辑静默失效但在线监视看着还在动。

人工核对手段：博途 **F11 交叉引用**、交叉引用工具栏的 **Show overlapping access**（查 `M12.3 / MB12 / MW11 / MD10` 这类跨类型重叠）、`程序信息 > 分配列表`。

**② 边沿位自查**
新加的上升/下降沿指令**不能复用**已有的 M 位。手册原文（S7-1200 System Manual §7.1.3）："you should use a unique bit for each edge instruction, and you should not use this bit any other place in your program."

**③ 定时器/计数器实例自查**
FB 里必须走多重实例（Static）；FC 里没有 Static，只能挂全局 DB，且**多次调用共用同一实例**。存量工程里如果同一个 FC 被两处调用，你新加的定时器会串味。

### 2.3 给用户确认的话术

> 我已导出改造前的现状，读到：**N 个程序块**、**M 个变量**、目标块 `<块名>` 的接口有 `<x>` 个形参。
>
> **请确认三件事**：① 我准备改的是 `<块名>`，它当前被 `<调用方>` 调用；② 我准备新占用的地址是 `<地址清单>`，我核对过它们在现有程序里未被写过；③ 工程副本已另存到 `<路径>`，出问题可整体回退。
>
> 确认后我开始改。

**这一步不能省。** 地址撞了、块选错了，后面全是白工，而且是带风险的白工。

---

## 阶段 3 · 改动最小化设计（本工作流的技术核心）

### 3.1 四条原则（🥉 惯例，按优先级排）

| 优先级 | 做法 | 为什么 |
|---|---|---|
| **1（最优）** | **新增一个块**，在 OB1 里加一次调用 | 现有块字节不动，风险最小，回滚只需删调用 |
| **2** | 在现有块**末尾追加新网络** | 不动已有网络的 UId 与顺序 |
| **3** | 修改现有网络的**操作数**（换变量、改设定值） | 结构不变 |
| **4（最差）** | **改块接口**（增删改形参） | ⚠️ 连带所有调用方 + 背景 DB，见 3.3 |

**默认走 1。** 只有当用户明确要求"改在原块里"时才降级。**任何时候不要为了"看起来整洁"去重排现有网络**。

### 3.2 UId 与网络续编的硬规则（🥇 实证）

**关键认知：SimaticML 导入是"整块替换"，不是增量补丁。** `ImportOptions.Override` 的官方语义是**先删后建**：

> "Relevant objects are **deleted prior to the import and recreated with default values**… If the existing object and the new object are not in the same group **overwriting can't take place**."

所以要在现有块里加网络，正确做法是：

```
① 导出该块的完整 S7DCL（阶段 1.3）
② 在导出的 XML 上追加新的 <SW.Blocks.CompileUnit>（新网络）
③ 新网络里所有 Part / Access / Wire 的 UId 从"现有最大 UId + 1"起编
④ 整块（旧网络 + 新网络）一起覆盖写回
```

**UId 编号纪律**：
- UId **在整个块内全局唯一**，不是每个网络重新起编（🥇 实证，《技术底座》规则 7）
- 续编时**先扫一遍导出文件里出现过的所有 UId 取最大值**，不要假设它们是连续的
- 未接的输出引脚必须显式接 `<OpenCon UId="新UId" />`，不能悬空

写错 UId 的直接后果【本机 V21 · BlockLogic】：
```
Opns_FalseNameCon              The part with UId '{0}' does not exist. The connection for the cable with UId '{1}' failed.
                               UID 为“{0}”的部件不存在，连接 UID 为“{1}”的电缆失败。
Opns_ReferenceConnectedMultipleTimes
                               The connection named '{0}' at the part with UId '{1}' is used multiple times at the cables.
                               在电缆的 UID“{1}”部件处，名为“{0}”的连接多次使用。
```

### 3.3 接口不能随便改（🥇 报错原文全部本机 V21）

改了 FB/FC 接口，编译期会连环报：

```
BL_CONTAINS_NONCOMPATIBLE_CHANGE  The interface of the block or data type contains incompatible changes.
                                  块接口或数据类型中包含不兼容的更改。
BL_TIMESTAMP                      Time stamp of called block or block used in the data hierarchy is more recent
                                  than the (caller) block. Interface conflicts can occur.
                                  被调用块或数据层级中所用块的时间戳比调用块的时间戳更新。这样会产生接口冲突。
BL_PARSE_1123                     Instance data block does not match called FB.
                                  背景数据块与被调用 FB 不匹配。
BL_PARSE_1124                     The time stamp of the instance DB does not match the called FB.
                                  背景数据块的时间戳与被调用 FB 不匹配。
BL_PARSE_10FF                     Missing instance DB.
                                  背景数据块缺失。
BL_PARSE_1173                     The data type {1} of the actual parameter does not match the data type {2}
                                  of the formal parameter {3}.
                                  实参的数据类型 {1} 与形参 {3} 的数据类型 {2} 不匹配。
```

**改接口的必做善后**（🥈 官方"更新块调用"行为，见《LAD 陷阱与编译错误原文》1.3）：
- 新增参数会被加入，但 **FB 的新参数默认隐藏**，要右键"显示所有参数"
- **已删除的参数不会自动移除，必须手工删**
- 重命名的参数会自动改成新名
- 官方 Note：若更新会导致参数供值出错，则**不能**用"更新块调用"

另外两条容易忘的：`BL_DB_ACCESS`「在 FB 调用中，只有完整资格的 DB 访问可用作实参」；`BL_UDT_CONFLICT`「至少有一个形参使用无效的 PLC 数据类型作为数据类型」——改 UDT 会连带打到这里。

**结论：接口改动必须升级为一次独立的、有用户书面确认的改造，不许夹在别的改动里顺手做。**

### 3.4 安全程序：一律不碰（🥇 报错原文；边界结论为【惯例，本项目强制】）

博途会用报错把边界钉死【本机 V21 · BlockLogic】：
```
BL_CHECK_1033                     A fail-safe block cannot invoke standard blocks.
                                  故障安全块不能调用标准块。
Opns_Feedback_ImportSupportedInFailSafeEnvironment
                                  The import failed. Fail-safe objects can only be imported into fail-safe programs.
                                  导入失败。故障安全块只能导入故障安全程序中。
Openness_Fbk_WrongIsFailsafeCompliant
                                  'IsFailsafeCompliant' can only be "true" when Simatic Safety is installed and a F-CPU is used.
                                  安装 Simatic Safety 并使用 F-CPU 时，“IsFailsafeCompliant”只能为“true”。
BL_NO_UPLOAD_FOR_FAILSAFE_BLOCK   The block '{0}' is an F-block and cannot be loaded from the device.
                                  块‘{0}’是一个 F 块，无法从设备装载。
```

**本工作流的硬规矩**：
- 工程里检测到 F 块 / 安全程序 → **AI 不生成、不修改、不覆盖任何 F 块**，只在报告里列出"以下块属安全程序，本次改造未触及"
- 标准侧新加的逻辑**不得成为"移除危险能量"这条链上的必要环节**（依据：标准 CPU + 标准 I/O ≈ ISO 13849-1 Category B / 上限 PL b；ISO 13850:2015 **4.1.5.1** 要求急停最低 PLr c 或 SIL 1）
- 急停回路走硬线经安全继电器直接切断动力、不经 PLC 程序 —— **【惯例，本项目强制】**，不是【标准强制】。ISO 13850:2015 **4.1.3** NOTE 2 明确允许电子手段（PDS 的 STO / SS1，IEC 61800-5-2），全文无 hardwired 字样；写成标准强制会被懂行的客户或第三方审核当场质疑

### 3.5 三个"能过 XSD 但导入必炸"的存量特有坑（🥇 实证 + 🥈 官方）

| 坑 | 后果 | 正确做法 |
|---|---|---|
| **分组路径不一致** | 官方原文："If the existing object and the new object are not in the same group **overwriting can't take place**. To avoid naming conflicts import is canceled" | 生成 XML 时块的分组路径必须与 `GetBlocksWithHierarchy` 读到的一致；需要新分组用 `CreatePlcBlockGroup`，移动块用 `MoveBlockToGroup` |
| **语言 culture 写死 `zh-CN`** | 目标工程没启用中文 → 导入直接失败（`Cannot import multilingual text with culture '{0}'…the specified culture does not exist within the current project.`） | **先查目标工程已启用的语言**；查不到就用工程默认语言，或用 V19+ 的 `ActivateInactiveCultures`（注意它与 `SkipInactiveCultures` **不能同时传**） |
| **块号撞车** | `BL_BLOCK_NUMBER_CONFLICT`：`This number is already assigned at another block. Correct the number conflict before compiling.` / `该编号已经在另一个块上分配。请在编译前修正编号冲突。` | 存量工程里**优先不写 `<Number>`**，让博途自动分配（🥈 官方："不给块号则自动分配"） |

⚠️ 另有一条与在线下载相关：`BL_StopModul_Block_Num`「Loading in "RUN" is not possible if blocks have been renumbered. Set the CPU to STOP before loading.」/「如果对块重新编号，则无法在“RUN”模式下进行加载。请在加载之前将 CPU 设置为 STOP。」——**这意味着重新编号会把一次"能在线改"的改造变成一次"必须停机"的改造**。存量工程尤其要避免动块号。

---

## 阶段 4 · 写入（三级确认链路一步不许省）

```
生成/改好 XML
  → XSD 校验（Test-YinFlgNet / POST /api/tia/validate）
  → 预检（POST /api/tia/preflight）
  → 【覆盖前先导出旧块存快照】← 存量工程的必需项，不是可选项
  → 确认弹窗（含 diff + 接口变更清单 + 调用方清单）
  → 写入（POST /api/tia/import）
  → 编译该块
```

**为什么覆盖前必须先导出旧块**：`Override` 在博途侧就是**先删后建**，删掉的内容不会有第二个地方留着。TASK-013 的 2.5 已确认现状缺陷——写入历史记的是**新内容**，从未经过本系统的旧块（比如客户三年前手写的那个 FB）一旦被覆盖就**永久丢失**。

**禁止**：
- ❌ 跳过 XSD 校验直接导入 —— 校验几百毫秒，导入失败排查半小时
- ❌ 认为"XSD 绿了就稳了" —— 🥇 实证：XSD 里 `xs:key`/`xs:keyref`/`xs:unique` **出现 0 次**，悬空 UId、缺 `Name` 的 `<Negated/>`、编造的指令名全都能过校验，到导入才炸
- ❌ 为了"自动化"跳过任何一轮确认（红线）

---

## 阶段 5 · 改造后必须**全工程**编译（不是只编译改的块）

**这是工作流 B 与 A 最关键的差别。** 工作流 A 里每块编译通过基本就等于全工程通过（因为块是你一个个建起来的）。工作流 B 里你改了一个块，**炸的往往是别人**——调用方、背景 DB、引用了同一 UDT 的另一个块。

```
POST /api/tia/mcp/call  →  CompileSoftware        （全工程软件编译）
POST /api/tia/mcp/call  →  CompileAndDiagnosePlc  （编译 + 诊断，推荐）
```

### 5.1 必须逐条看的警告（不要因为"只是警告"就放过）

| 报错/警告【本机 V21】 | 中文 | 存量场景下的真实含义 |
|---|---|---|
| `BL_UPDATE_BLOCK_DELETE` `{0} is no longer referenced and has therefore been deleted.` | `{0} 不再引用，因此将被删除。` | 🔴 **最危险的一条**。你的改动让某个东西失去引用，博途**替你删了**。必须确认被删的是不是客户还要用的 |
| `BL_PARSE_1178` `Address of tag {2} from tag table has been changed.` | `变量表中变量 {2} 的地址已更改。` | 你或别人动了变量表地址，程序里的引用跟着变了 —— 现场接线可能已经不对应 |
| `BL_PARSE_1159` `Data type of {1} does not match the data type of the actual parameter in the PLC tag table.` | `{1} 的数据类型与 PLC 变量表中实参的数据类型不匹配。` | 变量表类型与程序里用法不一致 |
| `Opns_Fbk_BlockIsInconsistent` `The block is not consistent` | `块不一致` | 块处于不一致状态，需要重新编译或修接口 |
| `BL_COMPILE_SECOND_RUN_NEEDED` `The data are not consistent. The block will be recompiled.` | `数据不一致。该块将重新编译。` | 提示性，但连续出现说明有结构性问题 |
| `Opns_Fbk_DefinedButUnusedReference` `The reference with the UID '{0}' is defined but not used.` | `UID“{0}”的引用已定义，但未使用。` | 生成的 XML 里有多余引用，虽不致命但说明生成逻辑有瑕疵 |

### 5.2 编译 0 错之后还要做的两件事

1. **`CompareSoftwareToOnline`**（需先 `GoOnline`）—— 确认离线工程与真机的差异**只有你这次改的部分**。如果冒出别的差异，说明现场另有人改过，必须先跟客户核清楚
2. **保存工程**（`SaveProject`）—— ⚠️ 保存会把所有修改固化，属 TASK-006 认定的危险操作，必须过用户确认

---

## 阶段 6 · 回滚路径（三层，必须写进交付文档）

| 层 | 能回滚什么 | 怎么做 | 局限 |
|---|---|---|---|
| **L1 · 块级** | 单个块的内容 | 历史面板 →「回滚到此版本」（走 preflight + 标准确认写入，与正常写入同一条链路） | 只覆盖经过本系统写入的块；`pre-overwrite` 快照是 TASK-013 才补上的 |
| **L2 · 覆盖前快照** | 被覆盖掉的旧块原文 | 阶段 4 导出的 S7DCL 文件 | 需要人工重新导入 |
| **L3 · 工程级** | 整个工程（含变量表、分组、硬件组态） | 打开阶段 1.4 用 `SaveAsProject` 存的 `<原名>_改造前_<日期>` | 会丢掉快照之后的所有改动，包括客户自己做的 |

**交付文档里必须把这三层写清楚，并给出 L3 的具体文件路径。** 只说"可以回滚"是空话。

---

## 阶段 7 · 交付（增量交付，不是重写一份）

工作流 B 的交付文档是**增量**性质的，八节：**① 改造范围声明**（改了/新增了哪些块、**没碰哪些**，尤其点名安全程序）→ **② 改造前基线**（阶段 2.1 四张表）→ **③ 改动清单**（逐块：改前→改后→为什么）→ **④ 地址变更表**（新占用的 I/Q/M/DB，是否需现场接线配合）→ **⑤ 接口变更清单**（有就必须单列，并列出所有受影响的调用方）→ **⑥ 修改履历**（来自 `tia_write_history`：时间/块名/操作人/是否覆盖/是否回滚过）→ **⑦ 回滚路径**（阶段 6 三层 + L3 实际路径）→ **⑧ 上机前必须现场确认**（命中积木的确认项去重合并 + 通用四条）。

**收尾话术**（不要说"改好了，可以用了"）：

> 改造已完成，全工程编译 0 错误 <n> 警告，工程副本在 `<路径>`。
>
> **接下来必须做的四件事**（编译通过 ≠ 可以下载）：
> 1. 在博途里对**改动过的块逐网络人工审查** —— 我改的是草稿
> 2. 用 **F11 交叉引用**核对本次新占用的输出没有被别处重复写（双线圈编译器不报警）
> 3. **PLCSIM 仿真**跑一遍，重点是急停分支和与既有逻辑的交界处
> 4. 逐项打勾交付文档的《上机前必须现场确认》
>
> 本次**未触及**安全程序 / F 块：`<清单>`。急停与安全回路仍由原硬线设计承担。

---

## 与产品功能的挂钩点

| 本工作流的步骤 | 由谁自动化 | 具体怎么接 |
|---|---|---|
| 阶段 0.2 判定工程非空 → 选 B 而非 A | **TASK-009** | `collectProjectContext` 的 L1 摘要已含块清单，工作流选择直接读它，无需额外查博途 |
| 阶段 1.1 三件套必读 | **TASK-009** | L1 注入软件树+变量表摘要；L2 按关键词从变量表挑相关条目；L3 用户点「把变量表带给 AI」全量注入 |
| 阶段 2.1 基线表 | **TASK-009 + TASK-014** | 四张表与交付文档的"程序结构表/IO 分配表"**同源**（`parseBlocksFromTree` + `GetPlcTagTables`），一次采集两处用，不许各写一遍 |
| 阶段 2.2 双线圈自查 | **TASK-012 → TASK-013** | 知识库给规则，TASK-013 生成多块时自查同一输出是否多处被写 —— 编译器不管，我们管 |
| 阶段 2.3 用户确认基线 | **TASK-013** | 复用 §2.3 确认弹窗，把基线表并入 diff 区 |
| 阶段 3.2 UId 续编 | **TASK-013** | 覆盖场景必须先导出旧块（§2.5 `pre-overwrite`），续编 UId 的基数就从这份导出里算 |
| 阶段 3.3 接口变更清单 | **TASK-013** | 确认弹窗的"接口变更清单"（§2.3）—— 弹窗里最要命的一栏 |
| 阶段 3.5 culture / 块号 / 分组 | **TASK-012 + TASK-005** | 生成前查目标工程已启用语言（不写死 `zh-CN`）；`<Engineering version>` 跟目标博途版本走 |
| 阶段 4 覆盖前快照 | **TASK-013 §2.5** | `enqueueTiaOp(importToTia)` **之前**插一次 `ExportBlocksAsDocuments`，以 `kind: 'pre-overwrite'` 入历史表；**一次导出，同时供确认弹窗 diff 用** |
| 阶段 5 全工程编译 + 警告分诊 | **TASK-013** | `CompileAndDiagnosePlc` → `lib/compile-diagnose.js` 结构化 → 命中 5.1 表里 KEY 时给专门的中文根因 |
| 阶段 6 三层回滚 | **TASK-013** | L1/L2 走历史面板；**L3（`SaveAsProject` 工程副本）目前没有产品入口，建议在"改造前"步骤里加一个** |
| 阶段 7 增量交付文档 | **TASK-014** | ①⑤⑦ 三节是工作流 B 特有的，模板需要一个 **B 变体** |

---

## 附 · 未证实项（勿当结论）

| 项 | 状态 |
|---|---|
| `GetCrossReferences` 对 LAD 块的实际返回质量 | **未实测**（工具自述 best-effort）。拿不到必须回退人工 F11 |
| `SaveAsProject` 在 PLC 在线状态下能否执行 | **未实测**。按"导出需离线"同理推断应先 `GoOffline`，属推断 |
| 覆盖写入后工艺对象引用是否需重新关联 | **未取证** —— 依赖 TASK-012A 的 MC_* 实证 |
| 存量工程里已有 `<Call>` 的块，导出后改一改再导回是否可行 | **未实测**。这是拿 TASK-012A 答案的一条捷径，值得优先试 |
