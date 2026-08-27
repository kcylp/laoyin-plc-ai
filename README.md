老殷工控 PLC 助手 — 西门子 TIA Portal V21 编程 AI 工作台

# 老殷工控 PLC 助手

老殷工控 PLC 助手是一套面向西门子 TIA Portal 的本机工程助手。前端提供三栏工程工作台，后端负责账号、AI 会话、写入队列、历史快照与博途在线引擎编排，底层通过 EngineerYin 与 TIA MCP 操作本机已打开的 TIA 工程。

## 架构三层

- 前端应用层：`index.html` 与 `web/` 模块负责聊天、代码块动作、确认弹窗、在线面板、输出面板、实时树和右侧检查器。
- 后端服务层：`server.js` 挂载认证、AI、管理、TIA 写入、TIA MCP 路由；`lib/tia-queue.js` 串行化所有博途操作；`lib/logger.js` 输出结构化操作日志。
- 博途执行层：`engineer-yin-bridge.js` 统一预检/导入入口，优先走常驻 `yin_worker.ps1`，`YIN_WORKER=0` 时回退一次性 `yin_import.ps1`；`tia-mcp-client.js` 负责 MCP 在线工具。

## 四条写入通道

- XML/LAD/FBD：走 EngineerYin XSD 与业务规则预检，确认后导入并编译。
- SCL：走 ExternalSources 源码通道，保留 BOM/编码与编译归因。
- STL：走 ExternalSources 源码通道，沿用同一预检、导入和编译链路。
- S7DCL：走 MCP/S7DCL 路径，保留 MLC 生成、命名修正和编译诊断。

## 启动方式

```bash
npm install
npm start
```

也可以直接运行根目录的 `启动老殷工控PLC助手.bat`。默认地址为 `http://localhost:3000`，管理后台为 `/admin.html`。

## 环境要求

- Node.js 22.5+，建议 Node 22 LTS 或更新版本。
- Siemens TIA Portal V21，并启用 Openness。
- 当前 Windows 用户已加入 `Siemens TIA Openness` 相关用户组。
- 本机已安装或随项目携带 EngineerYin 引擎与 TIA MCP 运行时。
- 需要 AI 对话能力时，在设置页配置可用的模型供应商和模型。

## 关键实测规则

- BOM/编码：SCL/STL 外部源按实测要求保留 UTF-8 BOM，避免 TIA 源码导入乱码或失败。
- CTU_INT：计数器相关示例保持 `CTU_INT` 规则，不回退到未验证写法。
- S7DCL MLC：S7DCL 通道保留 MLC/compile 诊断链路，不拆成与 XML/SCL/STL 分叉的实现。
- 泛型限制：泛型块仅在 LAD 路径使用，避免生成 TIA 不接受的 SCL/STL 泛型表达。

## 可靠性与运维

- 每次博途相关操作写入 `work/logs/tia-ops.jsonl`，字段为 `ts/user/op/target/ms/ok/err`。
- 启动时备份 `plc_assistant.db` 到 `work/db-backups/`，保留最近 7 份。
- `/api/env-check` 返回 `healthScore` 与 `issues`，用于首屏环境健康判断。
- `npm test` 运行单元与结构回归；`npm run e2e` 运行五个 UX 冒烟旅程并输出截图。

## 在线更新与公开发布

- 当前公开发布版为 `20260827`，程序更新版本为 `1.0.3`。绿色版托盘菜单提供“检查更新”；清单与 ZIP 只从公开 GitHub HTTPS 读取。
- 网络异常、清单缺失或 GitHub 返回错误时，程序只显示“当前无法检查更新，请稍后重试”，不会把 404 页面展示给客户，也不会影响当前版本。
- 发布顺序：先运行 powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\work\green-build\build-green.ps1，再计算 ZIP 的 SHA256/字节数并更新根目录 update-manifest.json，最后提交并推送源码、ZIP、清单同一版本。
- 更新器会再次校验大小和 SHA256，拒绝危险 ZIP 路径，不覆盖 %LOCALAPPDATA%\老殷工控PLC助手 下的授权、数据库、API Key 与个人数据；启动健康检查失败时回滚旧版本。
- GitHub 仓库地址：https://github.com/kcylp/laoyin-plc-ai。当前绿色包由 GitHub Release `20260827` 提供；不要只更新源码而不更新绿色 ZIP 和 manifest。

## 专属许可与打赏

- 本项目为老殷工控专属软件，保留所有权利。未经老殷工控事先书面授权，不得商用、收费交付、转售、再许可或重新分发；完整条款见根目录 `LICENSE.txt`。
- 打赏只代表自愿支持，不授予商业使用权、再分发权或其他许可。
- 支付宝打赏码：`docs/assets/支付宝打赏码.jpg`

![支付宝打赏码](docs/assets/支付宝打赏码.jpg)
