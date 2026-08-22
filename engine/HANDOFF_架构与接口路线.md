# Engineer Yin × 老殷工控PLC — 架构与接口交接文档

> 目的：把"用 AI 生成西门子 PLC 程序（含梯形图）并真正写进博途 V21"这条路线，
> 连同已实测的接口边界、当前唯一卡点、待办任务，完整交给下一个模型继续做。
> 本机环境：TIA Portal V21 Professional，用户名 lenovo，Desktop=C:\Users\lenovo\Desktop。

## 0. 一句话现状（2026-08-03 更新：梯形图已打通）

**全链路已实测跑通**：连博途 → 读块 → 安全命名 → XSD 校验 → 导入 → 编译。
**梯形图（LAD）已成功写入博途并编译 0 错 0 警**，块名 `LAD_StartStop`。
黄金样板：`samples\LAD_块级导入_起保停.xml`（唯一验证过的格式，改程序以它为基准）。

> 本文档 §6 原来写的"卡在 Namespace"已解决，破解过程见 §6-新。
> **维护范围：只维护 F:\工控软件\ 下这一套；桌面旧副本已废弃，用户随时删除。**

## 1. 三层架构

```
┌─ 入口层（三个平级入口，共用下面同一套能力）
│   ├─ 老殷工控网页平台   C:\Users\lenovo\Desktop\5\plc-ai-assistant\  (Node.js, npm start, :3000)
│   ├─ Claude Code skill  C:\Users\lenovo\.claude\skills\botu-programming\SKILL.md
│   └─ Kimi Code skill    C:\Users\lenovo\.kimi-code\skills\botu-programming\SKILL.md
│
├─ 大脑层（AI 生成 PLC 代码 / SimaticML XML）
│   └─ llm.js  6款模型: DeepSeek V4 Flash/Pro + K3/K3-256K/K2.6/Kimi-K2.7-Code
│              按 base_url 自动判协议(OpenAI /chat/completions 或 Anthropic /v1/messages)
│
└─ 引擎层（EngineerYin，本条路线的核心）  C:\Users\lenovo\Desktop\EngineerYin\
    ├─ src\EngineerYin.psm1        Openness加载 + FlgNet XSD校验（旧模块）
    ├─ src\EngineerYin.Write.psm1  连博途/读块/命名/导入/符号表/编译/导出（新模块，主战场）
    ├─ src\YinResolver.ps1         C# 原生程序集解析器（解决爆栈，见 §4）
    └─ schemas\*.xsd               21个官方XSD（LAD/FBD/SCL/STL/Graph...）
```

## 2. 数据流（目标形态）

```
用户自然语言需求
  → AI 生成 SimaticML 块 XML（FC 走 SCL/LAD，FB 自动配背景DB）
  → EngineerYin XSD 校验（不合法直接拒，脏XML碰不到项目）
  → 命名门禁：扫全项目已有 FC/FB/DB，自动避重名、避号段冲突
  → Import 进博途工作副本
  → Compile 拿结构化编译结果（错误→回退，成功→保存）
  → 符号表：标准英文名 + 中文注释
```

## 3. EngineerYin.Write.psm1 已导出接口（全部实测过，除标注外）

| 函数 | 作用 | 状态 |
|---|---|---|
| `Initialize-YinAssemblies` | 装 C# resolver + 预加载 net48 全部 DLL | ✅ |
| `Connect-YinPortal [-ProcessId]` | Attach 到运行中的博途实例，取第一个打开的项目 | ✅ 实测连上 项目1 |
| `Disconnect-YinPortal` | 释放 | ✅ |
| `Get-YinBlockInventory` | 递归扫全项目，返回 Blocks/Names/FcNumbers/FbNumbers/DbNumbers | ✅ 读出 FC#1 块_1 + OB#1 Main |
| `Get-YinCreateCapabilities` | 探测 Openness 提供哪些 Create/Import + 语言枚举 | ✅ 见 §5 结论 |
| `Assert-YinBlockRules` | 硬门禁：FC不带背景DB / FB必须背景DB / 背景DB必须有父FB / 全局DB独立 | ✅ 8用例全过 |
| `New-YinSafeBlockName` | 避重名+避号段，FB自动配背景DB名 | ✅ 真实项目验证 |
| `Import-YinBlock -XmlPath [-SkipValidation] [-Overwrite]` | XSD校验后导入 | ⚠️ **卡点，见 §6** |
| `New-YinTagTable -TableName -Tags` | 建符号表（英文名+中文注释） | ⏳ 代码就绪，未实测 |
| `Invoke-YinCompile [-SaveAfter]` | 编译并返回结构化诊断 | ✅ 实测 0错0警 |
| `Export-YinBlockXml -BlockName [-OutDir]` | 导出真实块XML（拿标准格式） | ✅ 导出 Main/块_1 |

## 4. 已攻克的三个深坑（改代码时别踩回去）

1. **AssemblyResolve 爆栈（不可catch，直接杀进程）**
   旧 `EngineerYin.psm1` 的 resolver 是 PowerShell ScriptBlock，作为 .NET 委托回调时每层吃巨大栈帧，`TiaPortal.Attach()` 深度依赖解析必然 StackOverflow。
   解法 = `src\YinResolver.ps1` 用 `Add-Type` 编译 C# 版 `EngineerYin.NativeResolver`（已加载优先 + 字典缓存 + 重入哨兵）。连接前必须先 `Initialize-YinAssemblies`。

2. **V21 拆包 + 广度反射爆栈**
   对 V21 程序集做 `GetMethods()` 广度扫描也会爆栈。只能用全名精确 `Get-YinType` 取类型；泛型方法（`GetService<T>`、`ExportOptions`枚举）必须反射绑定，不能用 PowerShell 的 `[T]` 解析时语法。

3. **PS 5.1 中文 GBK 陷阱**
   Write 工具生成的 .ps1 是 UTF-8 无 BOM，PS5.1 按 GBK 读→中文和引号错乱→解析崩。
   规则：**.ps1 脚本一律纯 ASCII；中文只放进 XML/数据文件**（XML 读取端按声明编码处理，不受影响）。

## 5. Openness 关键 API 边界（实测）

`Siemens.Engineering.Step7.dll` v21.0.0.0 的 `PlcBlockComposition` 只提供：
```
Import(FileInfo, ImportOptions)                          <- FC/OB/全局DB 唯一创建途径
Import(FileInfo, ImportOptions, SWImportOptions)
ImportFromDocuments(DirectoryInfo, String, ImportDocumentOptions)
CreateFB(String name, Boolean isAutoNumbered, Int32 number, ProgrammingLanguage)   <- FB 可原生创建
CreateInstanceDB(String name, Boolean isAutoNumbered, Int32 number, String instanceOfName)  <- 背景DB
```
**结论：没有 CreateFC / CreateGlobalDB / CreateOB。** FC、OB、全局DB 只能靠 XML `Import`。所以 §6 的 XML 格式必须打通，否则 FC 和梯形图都做不了。
语言枚举含：STL/LAD/FBD/SCL/DB/GRAPH/F_LAD/F_FBD... （梯形图=LAD，功能块图=FBD）

## 6-新. 块级 Import + 梯形图：已攻克（2026-08-03）

一路踩出来的四条硬规则，全部经真实导入 + 编译验证。**改 XML 前先读这四条**，否则会重复我踩过的坑：

| # | 规则 | 违反时的报错 |
|---|---|---|
| 1 | 根 `<Document>` 与块元素 `<SW.Blocks.FC>` **都不带 xmlns**；AttributeList 内必须有空的 `<Namespace />` | `Missing 'Namespace' identifier attribute` |
| 2 | `<Parts>` 下 `<Access>` / `<Part>` / `<Call>` **三者平级**；变量引用是顶层 `<Access><Symbol>`，不是 `<Part Name="Access">` | `An instruction with the name 'Access' cannot be found` |
| 3 | 常闭触点 = `Part Name="Contact"` + **`<Negated Name="operand" />`**。没有 `ContactNot` 这个指令名；`Negated` 必须带 `Name` 指明取反哪个引脚，空元素会失败 | `An instruction with the name 'ContactNot' cannot be found` / 泛化的 `Import failed at the object with UID` |
| 4 | `<FlgNet>` 元素上要带 `xmlns=".../FlgNet/v4"`，但送 XSD 校验前必须剥掉（官方 LADFBD XSD 无 targetNamespace） | schema 找不到元素声明 |

**破解方法值得记**：博途的报错会逐层告诉你合法元素列表（例如它主动列出 `Equation, Instance, TemplateValue, AutomaticTyped, Invisible, Negated, Comment`）；配合精读 XSD（`Neg_T` 的 `Name` 属性注释写着 "The name of the negated pin"）就能定位。**别靠猜**——博途安装目录里没有带触点的 FlgNet 样例可抄（已扫过）。

**已验证的产物**：
- `samples\LAD_块级导入_起保停.xml` — 黄金样板，含全部四条规则的注释
- 项目1 里的 `LAD_StartStop` (#11) — 实机导入成功，编译 0 错 0 警
- `RoundTrip_FC` (#10) — 更早的外壳格式验证（博途自己的导出改名导回）

## 6-旧. （历史记录）当初的卡点描述

**现象**：`Import()` 报 `Missing 'Namespace' identifier attribute from the '0' object at line number 7`。
**已排除**：给 `<SW.Blocks.FC>` 加 `xmlns` 是错的——博途真实导出的根 `<Document>` 无 xmlns，块元素也无 xmlns，`<Namespace />` 是 AttributeList 内的一个空元素。
**已定位真实格式**：`Export-YinBlockXml` 导出的 `C:\Users\lenovo\AppData\Local\Temp\yin_export\块_1.xml` 是博途认可的标准格式（§7 附结构）。
**下一步（未执行）**：用真实导出格式重新构造 FC_Test 导入文件 `C:\Users\lenovo\AppData\Local\Temp\fc_test_v3.xml`（已按真实格式写好：根Document无xmlns、块内`<Namespace />`保留、Input/Output加Start/Stop/Motor、NetworkSource注入SCL Token序列），再 `Import-YinBlock -SkipValidation` 试一次。**这一步一旦通过，FC + 梯形图路线即打通。**

需要下一个模型验证/修正的点：
- 真实导出的块_1 语言是 LAD，我改成了 SCL——确认 SCL 的 `<NetworkSource><StructuredText>` Token 序列格式是否被 V21 接受（备选：直接用 LAD 的 `<FlgNet>`，那才是"梯形图"本体）。
- 导入成功后必须 `Invoke-YinCompile` 验证块真的可编译，而不只是"进去了"。
- `Import-YinBlock` 里的 XSD 前置校验目前只认 `<FlgNet>`；SCL 块要改成按 `<StructuredText>` + SCL_v4.xsd 校验，LAD 块才用 FlgNet + LADFBD_v5.xsd。

## 7. 梯形图（LAD）能力的正解路径

用户强制要求梯形图。技术事实：
- 梯形图 = LAD，底层是 `<FlgNet>`（Parts: Access/Part/Call；Wires: Powerrail/NameCon/IdentCon；每元件 UId 必填且唯一）。
- FlgNet 的官方 XSD `SW.PlcBlocks.LADFBD_v5.xsd` **无 targetNamespace**，校验前必须剥 xmlns（引擎已处理）。
- 真正能导入的是**块级 Document XML**（`<SW.Blocks.FC>` 里含 `<SW.Blocks.CompileUnit>` 里含 `<NetworkSource><FlgNet ...>`）。
- 所以梯形图路线 = §6 的块级 Import 打通 + NetworkSource 里放 FlgNet（而非 StructuredText）。二者 XML 外壳相同，只是 NetworkSource 内容和 ProgrammingLanguage 标签不同（LAD vs SCL）。

**建议给下一个模型的验证顺序**：
1. 先用真实导出的块_1.xml **原样导回**（改个名避重名即可），确认 Import 外壳格式 100% 对——排除是不是我们注入内容出的问题。
2. 通过后，往 NetworkSource 注入一个最小 FlgNet（一个 Coil + Powerrail），导入 → 编译，确认 LAD 本体可行。
3. 再接 AI 生成的 FlgNet。

## 8. 网页平台 llm.js 附带修复（已实测）

- 协议自适应：`/anthropic` 结尾走 Anthropic Messages（x-api-key + content_block_delta），否则 OpenAI。
- 兜底模型从失效的 `deepseek-chat` 改成 `k3-256k`。
- 6 模型全部实测可对话（清干净端口上的旧进程后；旧进程揣着废 key 导致"Insufficient Balance"假象，Windows 上停 Node 要 `Stop-Process -Id` 按 PID 杀）。

## 9. 交给其他模型时最需要盯的三件事

1. **§6 的 Import Namespace** —— 这是全局阻塞点，优先级最高。
2. **梯形图走 FlgNet 而非 SCL** —— 用户要的是梯形图，别被 SCL 带偏（§7）。
3. **每次写博途前必须问用户**（用户明确要求），且导入后必编译验证，失败要能回退——别只看"块进去了"。


