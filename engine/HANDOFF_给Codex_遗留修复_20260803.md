# 交接给 Codex：EngineerYin 遗留修复任务（2026-08-03）

> 目的：老殷工控PLC 平台的博途写入引擎（EngineerYin）已跑通全链路，现交给你处理**三件遗留任务**。
> 你（Codex）负责修复与验证；Fable5 只做架构裁决与终审。开工前先读本文档 + §7 指定源码，别跳读。
>
> 本机环境：TIA Portal V21 Professional，用户 lenovo。博途需在运行中并打开项目1，EngineerYin 才能 Attach。

## 0. 当前工程位置（2026-08-03 起只维护这一套，桌面副本已废弃、随时被删）

- **网页平台**：`F:\工控软件\老殷工控PLC助手\`（Node.js，双击 `启动老殷工控PLC助手.bat` 或 `npm start`，:3000）
- **引擎**：`F:\工控软件\老殷工控PLC助手\engine\`（src/ schemas/ samples/，整目录拷走即用）
- 环境自检页 `env-check.html`：五项全绿 = Node/博途/用户组/AI/引擎
- 博途版本自动探测 `src\YinTiaDiscovery.ps1`：读注册表 `HKLM:\SOFTWARE\Siemens\Automation\Openness\21.0\PublicAPI\21.0.0.0\EngineeringVersion=V21`

## 1. 现状一句话

**全链路已实测跑通**：连博途 → 读块 → 安全命名 → XSD 校验 → 导入 → 编译。
**梯形图（LAD）已成功写入博途并编译 0 错 0 警**（块 `LAD_StartStop`）。
黄金样板 = `engine\samples\LAD_块级导入_起保停.xml`（唯一验证过的格式，**改程序以它为基准，别重新发明**）。

## 2. 三件遗留任务（按优先级）

### 任务 A｜星三角 FB：TON 的 FlgNet 格式验证 + 修 XML（最险，先做）

待修文件：`C:\Users\lenovo\AppData\Local\Temp\star_delta_fb.xml`（5 个网络，LAD 写的 FB）

- **已按黄金样板验证**：N1/N2/N4 的 Contact / Negated / Coil 布线与起保停样板一致；FB 特有 Static 区放 TON 的思路正确（定时器有状态必须 FB）。
- **两处手猜、大概率是错的，禁止直接拿去导入**：
  1. **N3 TON**：`<Part Name="TON" UId="221"><TemplateValue Name="time_type" Type="Type">Time</TemplateValue></Part>`——TON 的 FlgNet 表示是手猜的；且只接了 en/in/instance，**没有 Q 输出接到 SwitchDone、没有 PT 预设时间输入、没有 ENO**。格式没验证前不要用。
  2. **N5 复位线圈**：`<Part Name="CoilReset" />`——手猜的指令名，LAD 里真正的复位线圈指令名需查真实导出确认（起保停样板里没有复位线圈可抄）。
- **验证方法（别手猜端口名）**：用 Openness 建一个带 TON 的临时 FB → `Export-YinBlockXml` 导出 → 读真实 FlgNet 格式 → 套到 star_delta_fb.xml。复位线圈同理，建临时 FB 放个复位线圈再导出。
- **成功标准**：修好后 `Import-YinBlock`（默认走 XSD 校验）→ `Invoke-YinCompile` → **0 错 0 警**，5 个网络逻辑完整（启动自锁/星形/5秒TON/角形/停止全复位）。

### 任务 B｜New-YinTagTable 符号表：实机验证

代码位置：`EngineerYin.Write.psm1:454`（已导出），逻辑：表不存在则 `TagTableGroup.TagTables.Create`，逐 tag `Tags.Create` + 设 DataTypeName / LogicalAddress / 中文 Comment（`$tag.Comment.Items[0].Text`，已 try/catch）。

- **从未实机跑过**。要在博途项目1 上建一个小符号表，确认：表建出来了、tag 都进去了、地址/类型正确、**中文注释在 TIA 里能显示**。
- 可疑点：`Comment.Items[0]` 赋值失败会被 try/catch 吞掉导致中文注释静默丢失——验证时专门盯这个。

### 任务 C｜多网络块追加（纯代码改造 + 实机验证）

Openness 的 `Import` 是**整块替换**。要给已有块追加网络 = 整块 `Export-YinBlockXml` 导出 → 在 XML 里加一个 `<SW.Blocks.CompileUnit>`（新网络）→ `Import-YinBlock -Overwrite` 导回。

- 实现为 `EngineerYin.Write.psm1` 新函数（如 `Add-YinNetwork -BlockName -XmlNetworkPath`），或改现有函数。
- 可先纯写代码（不开博途），写完再实机验证。

## 3. 硬约束（改代码必读，防止踩回已解决的坑）

1. **AssemblyResolve 必须用 C# resolver**（`src\YinResolver.ps1`）。PS ScriptBlock 版会爆栈杀进程。连接前先 `Initialize-YinAssemblies`。
2. **禁止对 V21 程序集做广度反射**（GetMethods 会爆栈）。只用全名精确 `Get-YinType`；泛型方法用反射绑定，不能用 `[T]` 解析时语法。
3. **.ps1 脚本一律纯 ASCII**，中文只放 XML/数据文件（PS5.1 按 GBK 读 UTF-8 无 BOM 的 .ps1 会乱码崩）。写文件用 UTF-8 无 BOM 但内容纯 ASCII。
4. **每次写博途前必须问用户**，导入后必编译验证，失败要能回退。别只看"块进去了"。
5. **块级 Import 四条硬规则**（黄金样板 `samples\LAD_块级导入_起保停.xml` 里的注释也写了）：
   - 根 `<Document>` 与块元素**都不带 xmlns**；AttributeList 内要有空 `<Namespace />`
   - `<Parts>` 下 `<Access>`/`<Part>`/`<Call>` **平级**；变量引用是顶层 `<Access><Symbol>`，不是 `<Part Name="Access">`
   - 常闭触点 = `Part Name="Contact"` + `<Negated Name="operand" />`（没有 ContactNot；Negated 必须带 Name）
   - `<FlgNet>` 带 xmlns，但送 XSD 校验前必须剥掉（引擎已处理）

## 4. Openness API 边界（实测，决定能做什么）

`Siemens.Engineering.Step7.dll` v21 的 `PlcBlockComposition` 只有：
```
Import(FileInfo, ImportOptions)                        <- FC/OB/全局DB 唯一创建途径
CreateFB(name, autoNum, number, ProgrammingLanguage)   <- FB 可原生创建
CreateInstanceDB(name, autoNum, number, instanceOf)    <- 背景DB
```
**没有 CreateFC / CreateGlobalDB / CreateOB**——FC/OB/全局DB 只能 XML Import。
多网络追加走 Export→改XML→Import(-Overwrite)，`Import-YinBlock -Overwrite` 已支持（`ImportOptions.Override`）。

## 5. 已验证能力清单（Write.psm1 全部导出函数）

| 函数 | 作用 | 状态 |
|---|---|---|
| `Initialize-YinAssemblies` | C# resolver + 预加载 | ✅ |
| `Connect-YinPortal [-ProcessId]` | Attach 运行中的博途，取第一个项目 | ✅ 实测 |
| `Disconnect-YinPortal` | 释放 | ✅ |
| `Get-YinBlockInventory` | 递归扫全项目块 | ✅ 实测 |
| `Get-YinCreateCapabilities` | 探测 Create/Import + 语言枚举 | ✅ |
| `Assert-YinBlockRules` | 硬门禁（FC/FB/背景DB/全局DB） | ✅ 8用例 |
| `New-YinSafeBlockName` | 避重名避号段，FB 自动配背景DB名 | ✅ 实测 |
| `Import-YinBlock -XmlPath [-SkipValidation] [-Overwrite]` | XSD 校验后导入 | ✅ 已打通 |
| `New-YinTagTable -TableName -Tags` | 建符号表 | ⏳ **任务 B** |
| `Invoke-YinCompile [-SaveAfter]` | 编译 + 结构化诊断 | ✅ 0错0警 |
| `Export-YinBlockXml -BlockName [-OutDir]` | 导出真实块 XML 当模板 | ✅ 实测 |

## 6. 网页平台附带事实（改动时别破坏）

- AI 供应商完全自定义：`settings.html` 填 Base URL + API Key，协议自动识别（/anthropic 结尾→Anthropic，否则 OpenAI）；Key AES-256-GCM 加密存库
- 6 模型可对话（DeepSeek V4 Flash/Pro + K3/K3-256K/K2.6/Kimi-K2.7-Code）
- Windows 上停 Node 用 `Stop-Process -Id <pid>`（pkill 杀不掉）

## 7. 必须读的文件（按顺序）

1. `engine\HANDOFF_架构与接口路线.md` —— 完整架构文档（含 §6 四条硬规则的破解过程），**注意其内部路径是迁移前的，以本文档 §0 为准**
2. `engine\samples\LAD_块级导入_起保停.xml` —— 黄金样板（先读注释）
3. `engine\src\EngineerYin.Write.psm1` —— 主模块，任务 A/B/C 都改它
4. `engine\src\YinResolver.ps1` —— C# resolver（别换回 PS 版）
5. `engine\src\YinTiaDiscovery.ps1`、`engine\src\yin_import.ps1` —— 环境探测 / 导入脚本
6. `engine\schemas\SW.PlcBlocks.LADFBD_v5.xsd` —— LAD/FlgNet 官方 XSD（TON 格式验证要看它）
7. `C:\Users\lenovo\AppData\Local\Temp\star_delta_fb.xml` —— 任务 A 的待修文件

## 8. 汇报要求

- 完成任务后用「文件:行号 + 一句话」汇报改动，**禁止扔完整文件/diff**
- 每个任务都要写明：验证方式、实测结果（尤其编译诊断）、是否已问用户拿到写博途授权
