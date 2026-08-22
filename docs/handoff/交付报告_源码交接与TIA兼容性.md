# 老殷工控 PLC 助手：源码交接、绿色包与 TIA Openness 兼容性最终交付报告

## 1. 交付目标

本轮解决两个现场问题：

1. 其他客户复制绿色包后无法连接 TIA Openness；
2. 客户需要完整、可审查、可二次开发的源码交接包，但发行方真实 API Key、邮箱授权码、管理员/JWT 生产密钥、数据库、授权状态和运行日志不得外发。

本轮同时补齐了完整技术交接文档、客户部署/排障清单、API 安全边界参考和绿色包内的文档随包策略。

## 2. 本轮实际修改

### 2.1 TIA 路径兼容

修改 `tia-mcp-client.js`：

- 增加 TIA 主版本识别和 `YIN_TIA_MAJOR_VERSION`；
- 增加 `YIN_TIA_PORTAL_ROOT`/`TiaPortalLocation` 显式路径；
- 路径探测支持 `_InstalledSW\\TIAPxx\\EditionMain`、`TIA_Opns`、Openness PublicAPI 下的 `Siemens.Engineering.Base` 反推和默认 Program Files 扫描；
- 将 `--tia-portal-location`、`--tia-major-version` 显式传给 MCP；
- status 暴露脱敏的探测状态，不暴露密钥。

修改 TIA MCP C# 源码 `engine/tia-mcp/tools/tiaportal-mcp/src/TiaMcpServer/Siemens/Engineering.cs`：

- 与 Node 客户端保持同样的路径回退顺序；
- 保留 UTF-8 BOM，避免历史 PowerShell/编译链误读中文和 C# 文件。

### 2.2 客户诊断

新增 `tools/diagnose-tia.ps1`：只读检查 Windows/.NET、TIA 注册信息、Openness DLL、用户组、端口、MCP 文件和可选 `tia doctor`；输出 JSON/TXT，路径脱敏，不读取 `.env`、数据库、日志正文、Key、JWT 或 SMTP 凭据。

### 2.3 绿色包

修改 `work/green-build/build-green.ps1` 和 `verify-final.ps1`：

- 构建根目录使用脚本相对仓库根，不硬编码发行方 F 盘；
- 绿色包携带 `app\\tools\\diagnose-tia.ps1`；
- 绿色包 `说明文档` 携带完整 `docs\\handoff\\*.md`；
- 构建时只临时移除 `package.json` 的历史 UTF-8 BOM，finally 恢复原始字节；
- 打包前清理 MCP startup/log 文件；
- 纯度门禁拒绝 `.env`、`server.js`、`package.json`、数据库、日志、开发 node_modules、测试目录和构建残渣。

### 2.4 源码交接

新增 `tools/create-source-handoff.ps1`，从 Git HEAD 生成 tracked-files 起点，再排除敏感和本机运行产物，并写入 `SOURCE_HANDOFF_MANIFEST.json`、`README_源码交接包.txt`。

新增/完善以下完整交接文档：

- `docs/handoff/完整技术交接手册.md`
- `docs/handoff/API路由与安全边界参考.md`
- `docs/handoff/构建发布与客户部署手册.md`
- `docs/handoff/TIA_Openness故障排查.md`
- `docs/handoff/源码接手与客户问题处理清单.md`
- `docs/handoff/源码交接说明.md`
- `docs/handoff/交接包清单.md`
- 本报告

文档覆盖开发语言、技术栈、目录、启动链、全部主要 API、安全边界、TIA 前置条件、客户 Key 配置、绿色包结构、源码构建、升级回滚、故障证据、交接清单和已知限制。

## 3. 根因结论

旧实现把 TIA 安装根目录过度绑定到可选注册表键 `...\\_InstalledSW\\TIAP21\\TIA_Opns`。现实机器可能只有 `EditionMain` 或 `Openness\\21.0\\PublicAPI` 路径；此外还可能存在非默认安装目录、TIA 大版本不匹配、Openness 组未刷新、AllowList 未接受复制后的新 EXE 路径、工程未打开或包未完整解压等原因。

绿色包内置的 V21 MCP 不能替代客户本机 TIA Portal/Openness、许可证、Windows 用户组或 AllowList；V21 MCP 不能冒充 V20/V19/V18。

## 4. 可复现验证证据

### 4.1 代码测试

~~~text
node --check tia-mcp-client.js                 PASS
node --test test/tia-mcp-client.test.js       6/6 PASS
npm test                                      137/137 PASS
进入测试前提：仓库依赖已存在；测试不替代现场 TIA 实机验收。
~~~

新增 TIA 客户端测试覆盖：

- 没有 `TIA_Opns` 时使用 `EditionMain`；
- 显式 `YIN_TIA_PORTAL_ROOT` 优先；
- 原有 MCP 启动、工具调用、崩溃清理、超时重启保持通过。

### 4.2 真实 TIA doctor

~~~text
TiaMcpServer.exe --tia-portal-location "C:\\Program Files\\Siemens\\Automation\\Portal V21" --tia-major-version 21 tia doctor
退出码：0
结果：TIA V21 Openness API 初始化成功，用户组检查通过。
~~~

### 4.3 绿色包门禁

最后一次 `verify-final.ps1` 的关键结果：

~~~text
Required entries missing: 0
Forbidden directories: 0
Forbidden files: 0
Runtime Node bundled: False
PASS: package purity/structure gate
License API ok: True
Trial remaining days: 60
Login HTTP: 200
Tampered license exit code: 78
PASS: tampered license refusal
TiaMcpServer.exe present in package: True
TIA Portal V21 detected: True
冷启动：3860 ms
~~~

最终绿色 ZIP：

~~~text
F:\\工控软件\\老殷工控PLC助手\\work\\green-build\\老殷工控PLC助手_绿色免安装版_v1.0.zip
字节数：39,609,705
SHA256：6EBA7CF06F83036805FB0AAA685FFADDCACCA59B08323F700CB57947C713802E
MCP V21 SHA256：73D968BAB3F53AB2C94FFE775AF32C33951183F3E4E1B770EAD9EB368B26511A
~~~

包内已确认：启动器、SEA 后端、`app\\engine\\tia-mcp\\runtime\\v21\\TiaMcpServer.exe`、PowerShell/TIA 外置资产、诊断脚本和完整说明文档存在；包内无 `.env`、数据库、授权、日志、`server.js`、`package.json`、开发 `node_modules` 或测试目录。

### 4.4 密钥与敏感文件

- `git ls-files` 未发现 `.env`、数据库、SQLite、`license.json`、`work/logs` 或 `work/db-backups` 真实文件；
- 高置信密钥扫描未发现 OpenAI/GitHub/AWS/PEM/Bearer 等真实凭据模式；
- `.env.example` 中只有客户配置占位符和示例说明；
- 未打 tag，未创建 GitHub Release。

## 5. 客户必须做的事

1. 使用自己的 Key：AI、SMTP/IMAP、JWT_SECRET、ADMIN_KEY；
2. 安装与 MCP 主版本匹配的 TIA Portal/Openness；当前验证版本为 V21；
3. 加入 `Siemens TIA Openness` Windows 用户组并重新登录；
4. 打开目标 TIA 工程并按需设置 AllowList；
5. 绿色包完整解压，不在 ZIP 内直接运行、不只复制 `app` 或 `runtime`；
6. 连接失败时只提交脱敏诊断 JSON/TXT、包 SHA256、Windows/TIA/MCP 版本，不提交 `.env`、数据库、授权文件或完整日志。

## 6. 已知限制与未隐瞒事项

- 本轮修改了 C# 源码，但本机缺少 .NET Framework 4.8 Developer/Targeting Pack，因此 C# runtime 未重新编译；不能把源码修改宣称为已进入二进制 runtime。当前绿色包使用已有、实测通过的 V21 runtime，Node 客户端显式路径探测修复已验证。
- 客户的 TIA 大版本若不是 V21，需要对应版本 MCP runtime 和独立实测；不能靠设置路径冒充版本。
- 绿色包的真实 TIA 写入/编译仍依赖客户本机 TIA、工程状态、权限和 AllowList；本地 doctor 通过不等于所有客户工程写入已通过。
- 完整源码交给对方后，对方能修改离线授权逻辑；“完整交源码”和“源码接收者绝对无法绕过授权”不能同时成立。若需要不可绕过授权，应另行设计公钥签名许可证或在线授权服务。

## 7. GitHub 交付动作

本轮用户已明确授权推送 `origin main`。提交 SHA 和远端核验 SHA 以最终交付命令 `git rev-parse HEAD`、`git ls-remote origin refs/heads/main` 为准；本次不打 tag、不创建 Release。

源码交接 ZIP 必须在最终提交后运行：

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\create-source-handoff.ps1 -KeepDirectory
~~~

并核对 `SOURCE_HANDOFF_MANIFEST.json.gitCommit` 等于最终 HEAD，再计算源码 ZIP 的 SHA256。源码 ZIP 不提交到 GitHub，单独交给客户。

## 8. 归因

- 本报告所述 TIA 路径兼容、诊断脚本、绿色包构建门禁、交接脚本和文档为本轮完成；
- EngineerYin、授权、日志、队列、前端五项 G 能力和原有 TIA 业务规则属于既有基线，本轮未重写；
- C# runtime 未重编译是明确限制，不将源码变更归因到二进制运行时；
- 最终提交 SHA、GitHub 远端 SHA、源码 ZIP 字节数/SHA256 由交付命令在最终 HEAD 生成后记录在本次交接通知中。