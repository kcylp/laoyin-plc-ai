---
id: "workflow-d"
workflow_id: "D"
title: "排查编译错误"
标题: "排查编译错误"
type: "workflow"
review_status: "approved"
source: "知识库_工作流D_排查编译错误作战手册.md"
---
# 排查编译错误作战手册（工作流 D）

**适用** 用户拿着一堆红色报错来问："编译红了，怎么办？"
**执行者** AI（老殷工控PLC助手）
**版本** v1 · **日期** 2026-08-23 · **出具** ARCHITECT / Fable 5
**状态** 【草稿，待老殷审】

**证据等级构成**（定义见《知识库_总索引》第三节）
| 等级 | 本文中的内容 |
|---|---|
| 🥇 实证 | **本文所有报错原文**，逐条来自本机 TIA V21 卫星资源 DLL（`TIA_V21_报错原文_中英对照.tsv`，3605 条，四列 DLL/KEY/EN/ZH），均标注 DLL 与 KEY；XSD 与导入器实测行为；产品侧 API/工具名（源码实读） |
| 🥈 官方文档 | IEC check 开关语义、优化/标准混用的拷贝传递行为、`ImportOptions` 语义、异常体系与 `MessageData` 取法 |
| 🥉 通用工程实践 | 分诊顺序、三轮上限、诊断包清单 —— 标注为**惯例** |
| ❌ 不采信 | 内容农场编造的报错串，见附录黑名单 |

> **本文的绝对纪律**：出现在本文里的每一条英文/中文报错串，**都能在 `TIA_V21_报错原文_中英对照.tsv` 里按 KEY 查到原行**。没有出处的说法一律标【惯例】或【未证实】。**永远不要向用户复述一条查不到出处的报错原文。**

---

## 这份手册解决什么问题

用户贴过来一屏红字，AI 最常犯三个错：**只把英文翻一遍**（用户看得懂 "Tag not defined"，他不知道的是为什么会 not defined）、**凭印象猜根因**（猜错方向，用户越改越乱）、**编造报错原文**（🥇 已实证：流传的 `Only one coil is permitted`、`The instance … is not defined`、`A block instance must be assigned` 在 V21 的 3605 条消息目录里**查无此串**，是伪造的；AI 一旦复述，专业性当场归零）。

本手册的做法：**先分层，再查表，再按类别给标准处置。** 分层决定往哪个方向找，查表拿准确的中文，类别处置给可执行的下一步。

---

## 阶段 0 · 先固定事实（不问清这四件事就往下猜，一定走弯路）

| # | 要问清 | 为什么要紧 |
|---|---|---|
| 0.1 | 这是**导入期**报错还是**编译期**报错？ | 两套完全不同的消息族、不同的排查路径。见阶段 1 |
| 0.2 | 是**错误**还是**警告**？ | 警告不阻塞编译，但阶段 3.9 那几条警告比某些错误更危险 |
| 0.3 | **哪个块、哪个程序段（network）**？ | 报错文本里带 `line number` / `UID` / `NW {n}` 的都要抓出来 |
| 0.4 | 报错是**一条**还是**一片**？第一条是什么？ | 🥉 **首条优先**：编译错误强烈级联，后面几十条常常是第一条的连带。**先修第一条再重编**，不要试图一次修完 |

**要用户提供的最小材料**：完整报错列表（**原文照抄，不要转述**）+ 块名 + 博途版本。

⚠️ 一个常被忽略的前提：**要能拿到编译原文**。产品侧的取法（🥈 官方 + 🥇 源码）——C# 侧必须用 `ex.MessageData.Text` 并遍历 `ex.DetailMessageData`；**只读 `.Message` 会丢掉行号和 UID**，也就丢掉了本手册全部分层依据。

---

## 阶段 1 · 分层分诊（本手册的骨架）

《知识库_导入与编译错误诊断》第一节给了**三层分诊法**，但要注意它的适用边界：

> ⚠️ **原三层分诊法覆盖的是「导入失败」**（层① XML 格式 / 层② SimaticML 对象 / 层③ 网络语义）。**编译错误不在这三层里**——它发生在导入成功之后。
> 本手册据此把模型**扩成四层**，把编译期单独立为第 ④ 层。这是对既有文档的补充，不是改动。

### 1.1 四层分诊表

| 层 | 何时发生 | 报错文本特征（**看这个就能定层**） | 含义 | DLL 族 |
|---|---|---|---|---|
| **①XML 格式层** | 导入 | 出现 `Invalid XML` | XML 本身不合法（标签没闭合、非法字符） | DataExchange |
| **②SimaticML 对象层** | 导入 | 带 **`line number` / `line position`** | 块级结构、版本、属性、语言的问题 | DataExchange / Blocks.Importer |
| **③网络语义层** | 导入 | 带 **`at the object with UID`** | 梯形图内部的接线 / 指令名 / 符号问题 | BlockLogic（`Opns_*` / `Openness_*` 系列 KEY） |
| **④编译层** | 导入之后 | **不带 line/UID**，而是带 **块名 / `NW {n}` / 变量名 / 数据类型名** | 语法过了，语义不成立：符号、类型、接口、地址、指令可用性 | BlockLogic（`BL_*` 系列 KEY）/ SclPLL / BlockInterface |

**KEY 前缀就是最快的定层依据**（🥇 实证，来自 TSV 的 KEY 列规律）：
- `Opns_*` / `Openness_*` → 导入期（层②③）
- `BL_PARSE_*` / `BL_CHECK_*` / `BL_COMPILE_*` → 编译期（层④）
- `ERR_PA_*` / `WARNING_PA_*` → SCL 编译器（层④，SCL 块）
- `MsgGraph*` → GRAPH 块

### 1.2 层① / ② / ③ 的入口指引

这三层的完整处置见《知识库_导入与编译错误诊断》第二、三节，本手册不重复。只强调三条最高频的：

| 层 | 报错【本机 V21 · BlockLogic】 | 中文 | 真实根因 |
|---|---|---|---|
| ③ | `Opns_FalseNameCon`：`The part with UId '{0}' does not exist. The connection for the cable with UId '{1}' failed.` | `UID 为“{0}”的部件不存在，连接 UID 为“{1}”的电缆失败。` | Wire 指向了不存在的元件 —— UId 写错或 Part 漏了 |
| ③ | `Opns_ReferenceConnectedMultipleTimes`：`The connection named '{0}' at the part with UId '{1}' is used multiple times at the cables.` | `在电缆的 UID“{1}”部件处，名为“{0}”的连接多次使用。` | 同一个引脚接了两次。**并联要用 `Part Name="O"` + `Card`，不是把两根线接同一个引脚** |
| ③ | `Openness_FeedBack_MissingUID`：`The "Access" must contain a UID at the object with UID '{1}'.` | `在 UID 为“{1}”的对象处，“Access”中必须包含一个 UID。` | 缺必需属性 |

**🔴 层③ 最重要的一条纪律**：`An instruction with the name '{0}' cannot be found at the object with UID '{1}'` 这类"指令名找不到"，**最常见的根因是编造指令名**。因为 🥇 实证：所有官方 XSD 里 `xs:key`/`xs:keyref`/`xs:unique` **出现 0 次**，`Part/@Name` 是**自由字符串无 pattern** —— **`ContactNot`、`CoilSet`、`CoilReset`、`OBlock`、`XBlock`、`NBlock` 这些不存在的名字全都能通过 XSD 校验，到导入才炸。** 正确写法一律查《技术底座_FlgNet指令实证表》第二节白名单。

**"XSD 通过 ≠ 能导入"这句话要写进每一处相关文案。**

---

## 阶段 2 · 查中英对照（产品已内置 3605 条，不要靠翻译）

### 2.1 数据源

📄 **`TIA_V21_报错原文_中英对照.tsv`** —— 3605 条，四列 `DLL / KEY / EN / ZH`，由 .NET `ResourceReader` 从本机 TIA V21 的卫星资源程序集（`Portal V21\Bin\{en,zh-CHS}\*.resources.dll`）**正式读取**，key/value 成对。

这份数据**已作为产品资产内置进 `tia-error-hints`**（TASK-003）。所以：

> **AI 的动作不是"翻译报错"，是"查表 + 给根因 + 给下一步"。** 翻译谁都会，查得到 KEY 才说明你真的知道这条报错是什么。

### 2.2 怎么查（🥉 惯例，但很实用）

用户贴过来的是**实例**（参数已填），TSV 里是**模板**（带 `{0}` `{1}`）。所以：

1. **剥参数**：把引号里的具体名字、数字、地址挖掉，留下骨架
   `Tag "Motor_Run" not defined.` → 骨架 `Tag ... not defined.`
2. **拿骨架去匹配 EN 列**，取到 KEY 与 ZH
3. **两条纪律**：
   - 同一个语义**可能有多条模板**，必须都覆盖。例：变量未定义在本机 V21 里至少有三条不同的行 —— 见 2.3
   - **不要靠 KEY 名猜语义**。🥇 已发现反例：`Openness_Fbk_BlockLanguageNotSupported` 的消息内容其实是 `The block '{0}' is know-how-protected and cannot be exported.`（KEY 说语言不支持，消息说专有技术保护）。同类前例：`DataExchange` 里那条 `Atttibute` 是西门子自己的笔误，做正则时要照原文匹配

### 2.3 一个必须知道的措辞陷阱（🥇 实证）

"变量未定义"在本机 V21 至少有**三条不同的模板**，分属不同 DLL：

| DLL | KEY | EN | ZH |
|---|---|---|---|
| BlockLogic | `BL_PARSE_10F6` | `Tag {1} not defined.` | `操作数{1} 未定义。` |
| BlockLogic | `BL_PARSE_111B` | `Tag {1} is not declared.` | `变量 {1} 未声明。` |
| SclPLL | `ERR_PA_SYN_TagNotDefined` | `Tag '{1}' is not declared.` | `变量“{1}”未声明。` |

**⚠️ 注意**：常见写法 `Tag "..." is not defined` 是**不准确的合成**。真实模板是上面三条。做正则匹配**必须三条都覆盖**，且要注意 BlockLogic 侧 `not defined` 与 `is not declared` **两种措辞都有**。

### 2.4 🔴 西门子自己没翻译导入错误 —— 我方的差异化空间

🥇 实证：`Blocks.Importer`（42 条）与 `Consistency`（13 条）在 `zh-CHS` 下**根本没有对应 DLL**；`DataExchange` 的导入类消息虽有 zh 条目但**值与英文完全相同**（如 `Feedback.MissingIdentifierAttributes` 的 ZH 与 EN 一字不差）。

**所以中文版博途的客户遇到导入失败，看到的仍是生硬英文。层①②③ 的中文根因是我们自己写的 —— 这不是锦上添花，是填补西门子自己都没做的空缺，要写得比西门子好。**

---

## 阶段 3 · 按类别标准处置（层④ 编译错误主战场）

**每一类的格式固定：识别串 → 中文根因 → 下一步做什么 → 常见误判。**

### 3.1 符号 / 变量未定义

**识别串**：见 2.3 三条；另有 `MsgTypeDimensionConstNotFound`（BlockInterface）`The used constant '{0}' is not defined.` / `使用的常量“{0}”未定义。`；`BL_CHECK_105E` `The jump label '{1}' is not defined.` / `跳转标签“{1}”未定义。`；`BL_LABEL_MISSING_DEFINITION` `The jump label {1} used in network {0} is not defined.` / `程序段 {0} 中使用的跳转标签 {1} 未定义。`

**中文根因**：程序引用了工程里不存在的符号。**在 AI 生成场景下，头号原因是"AI 瞎猜地址与变量名"。**

**下一步**：
1. 拉当前工程的真实变量表（`POST /api/tia/mcp/tag-tables` → `GetPlcTagTables`），逐个核对
2. 变量确实该有但没建 → **先建变量表，再改程序**（顺序反了会继续报）
3. 变量存在但名字不同 → 改程序里的引用，不要改变量表（变量表对应现场接线）
4. **SCL 块专查漏 `#` 前缀**：漏 `#` 时标识符被当成全局 PLC 变量解析，表里没有 → 报"未声明"
   > ⚠️ 诚实标注：报错串是真机原文，但"漏 `#` 必然触发这一条"是**机理推断，未在真机造错验证**

**常见误判**：把它当"拼写错误"。在 AI 生成场景下 90% 是"根本没有这个变量"，不是拼错。

### 3.2 数据类型不匹配

**识别串**【本机 V21】：
```
BlockLogic  Data type '{1}' cannot be converted implicitly into data type '{2}'.
BlockLogic  Data type {1} is unknown.                     数据类型 {1} 未知。
BlockLogic  Operator '{1}' is not compatible with the data types of '{2}' and '{3}'.
BlockLogic  Compiler information: Type conflict.          编译器信息：类型冲突。
SclPLL  ERR_OPT_DATATYPEMISMATCH
        Data types in the value assignment are not compatible.   值分配中的数据类型不兼容。
SclPLL  ERR_PA_SEM_INVALIDTYPE_CASEEXPRESSION
        Invalid data type for CASE expression.                   CASE 表达式中的数据类型无效。
SclPLL  ERR_PA_SEM_ARRAY_INVALID_EXP
        Invalid data type in ARRAY expression.                   ARRAY 表达式的数据类型无效。
SclPLL  ERR_PA_SEM_InvalidOperand   Invalid operand.             操作数无效。
```

**🔑 排这一类必须先问一件事：块的 IEC check 开关**（🥈 官方，TIA Info System *Activate or deactivate IEC check*）
> "This compatibility test can be carried out according to criteria that are more or less strict. **If 'IEC check for code blocks' is activated, stricter criteria are applied.**"

两处开关：`选项 > 设置 > PLC 编程 > 常规 > 新块的默认设置 > 代码块的 IEC 检查`（对新块全局生效）＋**单块属性逐块设置**。

已核对的例子：`TIME→DWORD` 仅**关闭**时允许；`WORD→BYTE` 仅关闭时允许；`BYTE→WORD` 两种模式都允许。

**🔴 诊断纪律：同一段代码在 IEC check 开/关下编译结果不同。不先查块属性就排类型错，会得出互相矛盾的结论。**

**常见误判 —— 容易被当成类型错的合法写法**（🥈 官方 Programming Guideline §3.10.10）：SCL 支持操作数重载，`time + time` → Time、**`time + dint`** → Time、`tod + dint` → TOD、`ldt - ldt` → LDT、`dtl - dtl` → DTL。
⚠️ **表里有 `time + dint`，没有 `time + int`** —— 用 Int 报类型错、用 DInt 合法，这个差别很容易踩。

### 3.3 指令不存在 / 不可用 / 不被该 CPU 支持

**这三件事必须分开，处置完全不同。**

| 情形 | 识别串【本机 V21】 | 中文 | 处置 |
|---|---|---|---|
| **指令名不存在**（层③，导入期） | `An instruction with the name '{0}' cannot be found at the object with UID '{1}'` | — | **编造指令名**。查白名单，见阶段 1.2 结尾 |
| **指令版本不对**（层③） | `Cannot find an instruction with name '{0}' and version '{1}' at the object with UID '{2}'` | — | 如 TON 必须写 `Version="1.0"` |
| **指令不可用（配置文件）** | `BL_INSTRUCTION_MISSING`：`Instruction '{1}' is not available. Please check whether an instruction profile is active.` | `指令“{1}”不可用。请检查指令配置文件是否激活。` | 🥇 **这条最容易被误判成"CPU 不支持"**。真实原因是工程里启用了**指令配置文件（instruction profile）**把指令集裁掉了。让用户去查配置文件，不要让他换 CPU |
| **CPU 真的不支持** | `{0} NW {1}: The instruction {2} is not supported by the new CPU.`；`The programming language '{0}' used for block '{1}' is not supported by the CPU you are using.` / `不支持程序段语言 {0}。`；`This type of access is not supported by this CPU.` / `该 CPU 不支持此访问类型。`；`该 CPU 不支持 SCL。`；`程序段不支持该指令。` | 见左 | 换指令或换 CPU。**S7-1200 不支持 GRAPH**（🥈 四方交叉证实） |

⚠️ **区分**：搜索里常见的 "CPU not supported" 多指**在线连接时固件版本不匹配**，与编译期指令不支持是两回事，不可混用。

### 3.4 块接口 / 背景 DB / 时间戳（存量工程和改接口后的主战场）

**识别串**【本机 V21 · BlockLogic】：
```
BL_PARSE_1123  Instance data block does not match called FB.        背景数据块与被调用 FB 不匹配。
BL_PARSE_1124  The time stamp of the instance DB does not match the called FB.
                                                                    背景数据块的时间戳与被调用 FB 不匹配。
BL_PARSE_10FF  Missing instance DB.                                 背景数据块缺失。
BL_TIMESTAMP   Time stamp of called block or block used in the data hierarchy is more recent
               than the (caller) block. Interface conflicts can occur.
                              被调用块或数据层级中所用块的时间戳比调用块的时间戳更新。这样会产生接口冲突。
BL_CONTAINS_NONCOMPATIBLE_CHANGE
               The interface of the block or data type contains incompatible changes.
                                              块接口或数据类型中包含不兼容的更改。
BL_PARSE_1173  The data type {1} of the actual parameter does not match the data type {2}
               of the formal parameter {3}.    实参的数据类型 {1} 与形参 {3} 的数据类型 {2} 不匹配。
BL_PARSE_1175  Declaration "{1}" of actual parameter does not match the declaration "{2}"
               of formal parameter "{3}".      实参的声明“{1}”不符合形参“{3}“的声明“{2}“。
BL_DB_ACCESS   In the FB call, only fully qualified DB accesses can be used as actual parameter.
                                              在 FB 调用中，只有完整资格的 DB 访问可用作实参。
Opns_Fbk_BlockIsInconsistent  The block is not consistent            块不一致
```

**中文根因**：块的接口变了，但调用方 / 背景 DB / UDT 没跟着变。

**下一步（顺序很重要）**：
1. 对**被调用块**先编译一次 —— 时间戳类问题常常只是编译顺序问题
2. 在调用方右键 **"更新块调用"**。🥈 官方行为要点：新增参数会加入但 **FB 的新参数默认隐藏**（右键"显示所有参数"）；**已删除的参数不会自动移除，必须手工删**；重命名的参数会自动改名；**若更新会导致参数供值出错，则不能用"更新块调用"**
3. `Missing instance DB` → 见下方⚠️
4. 全工程重编译（不是只编译报错那个块）

⚠️ **一处必须区分、否则会读出矛盾的地方**（🥇 本轮发现）：《LAD 陷阱与编译错误原文》3.5 引手册"**STEP 7 automatically creates the DB when you insert the instruction.**"（在**博途编辑器里插入指令**时自动建背景 DB）；《导入与编译错误诊断》第四节引官方"**缺失的背景 DB 不会自动创建**"（走 **Openness/SimaticML 导入**时不建）。**两条都对，讲的是两条不同的路径。** 排 `Missing instance DB` 必须先分清用户是"在博途里手工插的"还是"我们导入进去的"—— 后者才需要手工补 DB。

### 3.5 地址 / DB 越界

**识别串**【本机 V21 · BlockLogic】：
```
BL_ERROR_OPERAND_RANGE   There is an invalid address in block {0}.    块 {0} 中包含一个无效地址。
BL_ACCESS_VIOLATION_DB   Access to DB '{1}' exceeds the length of the data block ({0}).
                                                  对 DB“{1}”的访问超出了数据块的长度 ({0})。
BL_PARSE_11A7            The address specified for "{1}"  is incomplete.
                                                  为 "{1}" 指定的地址不完整。
BL_CANNOT_ACCESS_DB      Data block cannot be addressed.              无法对数据块寻址。
BL_PARSE_1178            Address of tag {2} from tag table has been changed.
                                                  变量表中变量 {2} 的地址已更改。
BL_PARSE_1159            Data type of {1} does not match the data type of the actual parameter
                         in the PLC tag table.    {1} 的数据类型与 PLC 变量表中实参的数据类型不匹配。
```

**下一步**：
1. 拿真实 CPU 型号核对 I/O 地址范围（例：1214C DC/DC/DC 板载 DI 14 点 `I0.0-I1.5`、DQ 10 点 `Q0.0-Q1.1`）
2. DB 越界 → 看 DB 的实际长度和成员偏移，不要靠算
3. `BL_PARSE_1178`（变量表地址已改）→ ⚠️ **这条在存量工程里是危险信号**：程序引用跟着变了，但**现场接线没变**。必须让用户核对
4. **PTO 占用的输出（如 Q0.0/Q0.1）不能再作普通输出使用**

### 3.6 优化访问 / 绝对寻址

**识别串**【本机 V21，带 KEY】：
```
BL_PARSE_11A5              Absolute access to data in blocks with optimized access is not permitted.
                           不允许在具有优化访问的块中对数据进行绝对寻址。
ERR_PA_SEM_BlockAccess     Source and target block have to have the same block access type
                           (optimized access or standard access).
                           源块和目标块的块访问方式必须相同（优化访问或标准访问）。
                           You cannot access an optimized memory area from this location.
                           The reference does not point to an optimized data block.   该引用未指向一个已优化的块。
                           Avoid absolute access to the local data stack. Define a temporary variable
                           in the block interface.
                           避免使用绝对地址访问本地数据栈。请在块接口中定义一个临时变量。
                           不支持对多实例中的单个元素进行部分访问。
BlockAccessM2              If you activate this attribute, you can no longer address the block
                           parameters absolutely. You may have to adapt and recompile the program.
                           如果激活该属性，则无法继续完全寻址该块参数。可能需要进行修改并重新编译程序。
```

**🔴 附带一个编译不报错的隐藏行为（必须主动告诉用户）**（🥈 官方 PG 原文摘要）：优化与标准**混用**时，参数一律退化为 **copy** 传递，且回写发生在**块调用结束之后**（"all parameters are generally transferred as **copy**… they are copied back to the original operand, **after** processing of the block call"）。这是"块内改了值但外面没同步""两个块之间时序错乱"的根因，**编译不报错**。

### 3.7 块号 / 分组 / 递归 / 写保护

```
BL_BLOCK_NUMBER_CONFLICT  This number is already assigned at another block.
                          Correct the number conflict before compiling.
                          该编号已经在另一个块上分配。请在编译前修正编号冲突。
BL_PARSE_1138             PLC data type is being used cyclically, that is, there is a direct
                          or an indirect recursion.
                          PLC 数据类型正被循环使用，即，存在直接或间接的递归调用。
BL_PARSE_10CC             Block was already referenced or processed. Delete the declaration/call
                          in which this block is used.
                          块已被引用或处理。删除使用该块的声明/调用。
Opns_Fbk_ReadOnlyContext  Attribute '{0}' must not be set in a write-protected environment.
                          在写保护环境中，不得设置属性“{0}”。
```

**块号冲突的最优处置**：🥈 官方"不给块号则自动分配" → **干脆不写 `<Number>`**，让博途自己分。

### 3.8 编码 / 非法字符（中文工程高频）

```
（层③，导入期）The value of attribute '{0}' at node '{1}' with UID '{2}' contains an invalid
              character at Position {3}.
              The character string contains invalid characters.
```

**中文根因**：99% 是**编码问题**，不是"中文不能用"。🥇 XSD 侧已确认 `SimaticName_TP` 是 `<xs:restriction base="xs:string"/>`，**无 pattern 限制** → 中文变量名能过 XSD。

**乱码识别**（🥇 字节验算，完整对照表见《LAD 陷阱与编译错误原文》2.1）：UTF-8 字节被按 GBK/CP936 解码，`启动`→`鍚姩`、`急停`→`鎬ュ仠`、`复位`→`澶嶄綅`。

**两条硬纪律**：
1. **不可回转** —— `鍚姩` 按 GBK 只有 4 字节，与原始 6 字节不等长，字符串手术修不回来。**只能从源头改编码声明**
2. **匹配不要用 `鍚姩` 字面量** —— `启动` 的乱码实际是 3 个字符（`鍚` + 不可见的 U+E21A + `姩`）。改为检测 U+E000–U+F8FF 私用区字符连续出现，或直接查字节序列

**未取证**：导入文件是否要求 UTF-8 **with BOM**。🥇 在 `BlockLogic` / `Blocks.Importer` 中搜 `encoding|UTF-8|code page` **零命中**，间接说明 TIA 不为编码问题专门报错。**不要在回答里断言 BOM 要求。**

### 3.9 线圈 / 网络结构 + 三条"比错误更危险的警告"

**结构类报错**【本机 V21 · BlockLogic】：
```
BL_TOO_MANY_COILS   Too many coils in one network. A maximum of 16 parallel coils is allowed.
                    一个程序段中的线圈太多。最多允许有 16 个并联线圈。
                    A coil/assignment is required.                       需要线圈/分配。
                    The coil/assignment requires a preceding logic operation.
                                                                         线圈/分配需要一个前导逻辑运算。
                    Within an FC, a coil that is connected to a BLOCK_FC-type parameter must not
                    be preceded by a logic operation.
（层③）No 'NameCon' defined for rung at the object with UID '{0}'.        某个梯级没有接线
```
**❌ 社区流传的 `Only one coil is permitted` 在 V21 消息目录里查无此串，是伪造的。一个 network 可以有多个线圈，上限 16 个并联。**

**🔴 三条最危险的"警告"**（不阻塞编译，但会咬人）：

| 报错/警告 | 中文 | 为什么危险 |
|---|---|---|
| `BL_UPDATE_BLOCK_DELETE`：`{0} is no longer referenced and has therefore been deleted.` | `{0} 不再引用，因此将被删除。` | 🔴 **博途替你删了东西**。必须确认被删的不是客户还要用的 |
| `BL_COMPILE_SECOND_RUN_NEEDED`：`The data are not consistent. The block will be recompiled.` | `数据不一致。该块将重新编译。` | 单次出现属提示；**连续出现说明有结构性问题** |
| `Opns_Fbk_DefinedButUnusedReference`：`The reference with the UID '{0}' is defined but not used.` | `UID“{0}”的引用已定义，但未使用。` | 说明生成的 XML 里有多余引用 —— 生成逻辑有瑕疵，早修早好 |

**以及编译器完全不管的两件事**（🥇 双向确认无警告，`BlockLogic` 3256 条里搜 `coil|multiple assign|written more|assigned more` **零命中**）：
- **双线圈**：同一输出多处被写，后写覆盖先写，前面的逻辑静默失效。只能靠 **F11 交叉引用** / **Show overlapping access** / `程序信息 > 分配列表` 查
- **边沿位复用**：多实例共用同一 M_BIT，边沿互相吞掉

**"编译 0 错误"从来不等于"程序对"。收尾话术里必须说这句。**

### 3.10 安全程序（F 块）相关

```
BL_CHECK_1033          A fail-safe block cannot invoke standard blocks.   故障安全块不能调用标准块。
Opns_Feedback_ImportSupportedInFailSafeEnvironment
                       The import failed. Fail-safe objects can only be imported into fail-safe programs.
                       导入失败。故障安全块只能导入故障安全程序中。
Openness_Fbk_WrongIsFailsafeCompliant
                       'IsFailsafeCompliant' can only be "true" when Simatic Safety is installed
                       and a F-CPU is used.
                       安装 Simatic Safety 并使用 F-CPU 时，“IsFailsafeCompliant”只能为“true”。
```
**处置**：一律**停手，转人工**。AI 不修 F 块、不改安全程序。在报告里声明边界即可。

**边界表述纪律**：急停回路走硬线经安全继电器直接切断动力、不经 PLC 程序 —— 写 **【惯例，本项目强制】**，不写【标准强制】。（ISO 13850:2015 **4.1.3** NOTE 2 明确允许电子手段：PDS 的 STO / SS1，IEC 61800-5-2；全文无 hardwired 字样。写成标准强制会被懂行的客户或第三方审核当场质疑。）

---

## 阶段 4 · 修不动的时候：三轮上限与诊断包

### 4.1 三轮上限（🥉 惯例，但是硬规矩）

```
第 1 轮：按阶段 3 的类别处置 → 重编译
第 2 轮：还错 → 换假设（尤其：先查 IEC check、先查块访问方式、先查是不是级联的第一条）
第 3 轮：还错 → 停。不要第 4 轮
```

**立即停止的三个信号**：
- 两轮的报错**完全相同** → AI 修不动了，继续只是烧 token
- 报错**从 1 条变成 20 条** → 方向错了，先回滚再重来
- 出现 F 块 / 保护块相关报错 → 转人工

### 4.2 何时该导诊断包

**四种情形该导**：① 三轮修不动；② 报错在 TSV 3605 条里**查不到骨架**（可能是别的 DLL 族、别的 TIA 版本，或用户转述失真）；③ 报错**自相矛盾**（改 A 报 B、改回来又报 A —— 典型是 IEC check / 块访问方式这类"开关性"因素）；④ 用户要把问题升级给我们。

**诊断包清单**（全部只读，走 `POST /api/tia/mcp/call`）：

| 内容 | 工具 / 通道 | 说明 |
|---|---|---|
| **标准化错误报告** | `GenerateErrorReport` | 官方："Generate a standardized Markdown/JSON error report. This is **file/report generation only**; it does not touch TIA Portal or modify projects." |
| **环境验收报告** | `GenerateAcceptanceReport` | 官方：默认模式 "does not attach to TIA or write to the project"，只写文件到 `outputDirectory` |
| **发布诊断报告** | `BuildReleaseDiagnosticReport` | |
| **环境自检** | `Doctor` / `RunCapabilitySelfTest` / `GET /api/tia/mcp/status` | 排除"根本没连上/版本不对"这类伪问题 |
| **出错块源码** | 左树点块 →「导出 S7DCL」（`ExportBlocksAsDocuments`） | ⚠️ 需**工程离线**；⚠️ 同名块会被产品以 409 拒绝导出 |
| **编译原文** | `CompileAndDiagnosePlc` 完整输出 | **必须原文，不要转述** |
| **版本三件套** | 博途版本 / CPU 订货号 / 固件版本 | 报错模板逐版本有差异（🥇 XSD 文件名逐代跳版：V19–V21 是 `LADFBD_v5`、V16 是 `LADFBD_v3`） |

**一条捷径**：`RepairAndReimportBlock` —— 官方："Try import a block XML; if compile fails, return diagnostics and best-effort suggestions (**no destructive actions**)."。只读安全，值得在第 2 轮先试一次。

⚠️ **诊断包必须脱敏**：不含 API Key、绝对路径、客户内部信息（复用 `lib/sanitize.js`）。

### 4.3 回滚（三层，与工作流 B 同一套）

| 层 | 能回什么 | 怎么做 |
|---|---|---|
| L1 块级 | 单个块内容 | 历史面板 →「回滚到此版本」（走 preflight + 标准确认写入，与正常写入同一条链路） |
| L2 覆盖前快照 | 被覆盖掉的旧块原文 | 写入前导出的 S7DCL（TASK-013 的 `pre-overwrite`） |
| L3 工程级 | 整个工程 | 改造前用 `SaveAsProject` 存的副本 |

**回滚本身也是一次写入**，必须走同样的确认链路，不许开后门。

---

## 阶段 5 · 反模式清单（AI 排错时最容易犯的七条）

| ❌ 反模式 | 为什么错 | 正确做法 |
|---|---|---|
| **编造报错原文** | 内容农场会编出看似合理的串。已实证 `Only one coil is permitted` / `The instance … is not defined` / `A block instance must be assigned` 全是伪造 | 只引 TSV 能查到的；查不到就说"这条我没有出处" |
| **只翻译不给根因** | 用户看得懂英文，他要的是"为什么"和"下一步" | 三段式：中文根因 → 下一步 → 常见误判 |
| **一次修一片** | 编译错误强烈级联 | 🥉 首条优先，修一条重编一次 |
| **不查 IEC check 就排类型错** | 同一段代码开/关结果不同 | 先问块属性 |
| **把"指令不可用"当"CPU 不支持"** | `BL_INSTRUCTION_MISSING` 的原文明确指向**指令配置文件** | 先让用户查配置文件 |
| **以为 XSD 绿了就稳了** | 🥇 XSD 无 `xs:key`/`keyref`，编造的指令名都能过 | 两道门都要过，白名单是唯一前置防线 |
| **说"编译 0 错误，可以用了"** | 编译 0 错不证明逻辑对、接线对、整定值对，更不证明安全 | 收尾必须带《上机前必须现场确认》 |

---

## 与产品功能的挂钩点

| 本工作流的步骤 | 由谁自动化 | 具体怎么接 |
|---|---|---|
| 阶段 0 固定事实（层次/块/首条） | **TASK-003 + TASK-013** | C# 侧改用 `ex.MessageData.Text` + 遍历 `ex.DetailMessageData`。**只读 `.Message` 会丢行号和 UID，分层就没依据了** |
| 阶段 1 四层分诊；层③ 报错带 UID | **TASK-003** | `lib/tia-error-hints.js` 按四层建规则；用户看到的第一句应是"这是第 ③ 层问题：梯形图内部接线错误"。报错带 UID 时前端要把 **UID 映射回元件名**一起显示（"UID 26 = Part Name=\"O\""），否则裸数字毫无用处 |
| 阶段 2 查表 / 剥参数 / 一语义多模板 | **TASK-003（TSV 已内置）** | 建索引时把 `{0}` 换通配、按骨架建倒排；**不靠 KEY 名猜语义**（`Openness_Fbk_BlockLanguageNotSupported` 是反例）；"变量未定义"三条模板必须全覆盖 |
| 阶段 3.1 符号未定义 | **TASK-009**（根治）+ **TASK-013**（修复） | 🔴 **根治手段是 TASK-009 的项目上下文注入** —— AI 拿到真实变量表就不会瞎猜地址。TASK-013 自动修复时要把相关变量表一起喂回去 |
| 阶段 3.2 类型不匹配 | **TASK-003** | 中文提示里**必须提醒先查块的 IEC check 属性**，否则会得出矛盾结论 |
| 阶段 3.8 乱码 | **TASK-003** | 检测私用区字符连续出现，**不要匹配 `鍚姩` 字面量** |
| 阶段 3.9 双线圈 / 边沿位复用 | **TASK-012 → TASK-013** | 编译器不管，我们管：生成多块时自查同一输出是否多处被写 |
| 阶段 3 全部类别 → 结构化 | **TASK-013 §2.4** | 抽出 `lib/compile-diagnose.js`（纯函数可单测），输出 `{ severity, blockName, network, line, code, message, 中文根因, 修复建议, 可自动修复 }`。**喂回 AI 用结构化数据，不是原始文本** |
| 阶段 4.1 三轮上限 | **TASK-013** | 硬上限 3 轮 + 累计 token 上限 + **两轮报错完全相同则立即停止**；每轮留痕 |
| 阶段 4.2 诊断包 | **TASK-013 + TASK-014** | 三轮失败时的三选项之一；清单按本节表格组装，**必须过 `lib/sanitize.js` 脱敏** |
| 阶段 4.3 三层回滚 | **TASK-013 §2.5** | `pre-overwrite` 快照是 L2 的前提。⚠️ **L3（`SaveAsProject` 工程副本）目前没有产品入口，建议补** |
| 阶段 5 反模式 + 收尾话术 | **TASK-012 → prompt** / **TASK-014** | 黑名单与"查不到出处就说查不到"写进 system prompt；收尾必须带"编译 0 错误 ≠ 上机能跑"+《上机前必须现场确认》 |

---

## 附 · 引用纪律与未证实项

**证据卫生不在本文重复。** 内容农场黑名单、已判定为伪造的报错串、抓不到的站点清单，见《知识库_总索引》第五节；换 TIA 版本时重新生成 TSV 的 PowerShell 脚本，见《知识库_LAD陷阱与编译错误原文》第零节。**一份数据一个来源，不许在这里再写一份会漂移的副本。**

| 未证实项 | 状态 |
|---|---|
| SCL 漏 `#` 前缀"必然"触发 `Tag '{1}' is not declared.` | **机理推断，未在真机造错验证** |
| 导入文件是否要求 UTF-8 with BOM | **未取证**（两个 DLL 中搜编码关键词零命中） |
| 边沿指令"只能访问 InOut/Temp 段"与手册"避免 Temp 作 M_BIT" | **矛盾未消解，需真机验证** |
| 本文全部模板取自 **V21** | V16–V19 措辞大概率一致，但要标注版本就得在目标版本上复跑一次提取 |
| GRAPH 是否需单独 license | **未取证**（S7-1200 不支持 GRAPH 已四方交叉证实） |
