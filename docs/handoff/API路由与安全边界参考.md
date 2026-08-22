# API 路由与安全边界参考

> 本文是源码接手者的接口地图。最终事实以交付时 Git HEAD 的 server.js、routes/ 与 test/ 为准；改路由前必须同步检查鉴权、localOnly、队列和确认链路。

## 1. 统一请求与响应约定

- 默认地址为 http://localhost:3000，PORT 可由客户自己的 .env 覆盖。
- 需要登录的接口使用 Authorization: Bearer <JWT>。
- TIA 本机接口同时执行 JWT 鉴权与 localOnly；localOnly 只允许本机回环来源，不能为远程调试删除。
- 管理接口由 checkAdmin 校验 ADMIN_KEY，不接受普通用户 JWT 代替管理员认证。
- 成功响应通常包含 success:true；参数错误返回 400/422，未登录返回 401/403，执行失败返回 500/502。错误响应不得包含密钥、数据库内容、绝对路径或 Node 堆栈。
- 所有 TIA/EngineerYin 操作必须通过全局串行队列，禁止在路由里直接并发启动 MCP 或 PowerShell。
- 前端隐藏按钮不是安全边界；后端仍须验证请求内容、预检事实、一次性确认 token 和危险工具的 confirmed 条件。

## 2. 认证与账号（挂载前缀 /api）

| 方法 | 路径 | 保护 | 作用 |
|---|---|---|---|
| POST | /api/register | 公开 | 注册用户；是否需要审批由配置决定 |
| POST | /api/login | 公开 | 登录并签发 JWT |
| GET | /api/approve?userId=...&token=... | 审批链接 token | 邮件/链接审批回调；token 不写日志 |
| GET | /api/verify | JWT | 验证当前 JWT |
| GET | /api/user | JWT | 返回当前用户基本信息，不返回密码 |

JWT_SECRET 必须由每个客户自行生成。仓库中若保留开发回退值，只能理解为开发兼容，不得作为生产配置；客户接手第一件事就是在本机 .env 覆盖。

## 3. 工作台、聊天和模型

| 方法 | 路径 | 保护 | 作用 |
|---|---|---|---|
| GET | /api/workbench/status | JWT | 工作台状态与额度 |
| GET | /api/check-questions | JWT | 查询问题额度 |
| POST | /api/use-question | JWT | 消耗问题额度 |
| POST | /api/chat | JWT | AI 对话/流式响应 |
| POST | /api/chat/clear | JWT | 清理当前会话 |
| GET | /api/models | JWT | 当前用户可用模型 |
| POST | /api/models/current | JWT | 切换当前模型 |
| GET | /api/ai/providers | JWT | 供应商列表与掩码状态 |
| POST | /api/ai/providers | JWT | 保存供应商；Key 加密落库 |
| GET | /api/ai/providers/:id/key | JWT + localOnly | 本机读取必要的密钥编辑状态；不得远程开放 |
| POST | /api/ai/providers/:id/test | JWT | 测试供应商通道 |
| DELETE | /api/ai/providers/:id | JWT | 删除供应商和模型 |
| POST | /api/ai/fetch-models | JWT | 用客户请求中的 Key 拉模型，不应把原文持久化 |
| POST | /api/ai/providers/:id/models | JWT | 保存模型选择 |

客户必须使用自己的 DeepSeek/K3/兼容网关 Key。发行方 Key 不在 GitHub、源码 ZIP、绿色包或文档中。

## 4. 环境、许可和管理员

| 方法 | 路径 | 保护 | 作用 |
|---|---|---|---|
| GET | /api/env-check | 当前实现为环境状态接口 | 返回 Openness、AI、MCP、邮件状态、healthScore 和 issues；不应返回 Key 或敏感绝对路径 |
| POST | /api/admin/verify | 管理员密钥 | 管理员登录验证 |
| POST | /api/admin/get-users | 管理员密钥 | 获取用户列表 |
| POST | /api/admin/approve | 管理员密钥 | 批准/拒绝用户 |
| POST | /api/admin/update-questions | 管理员密钥 | 调整额度或付费状态 |
| GET | /api/license | 公开 | 返回本机离线授权状态，不返回授权文件路径 |
| POST | /api/system/shutdown | localOnly | 启动器关闭服务；必须保持本机限制 |

ADMIN_KEY 只放客户自己的 .env。管理员页面是本机管理面，不等于公开 API。

## 5. EngineerYin / XML 写入路由

| 方法 | 路径 | 保护 | 作用 |
|---|---|---|---|
| POST | /api/validate | JWT | XML/XSD 与 LAD 业务规则校验 |
| POST | /api/tia/validate | JWT | TIA 路由版本的校验 |
| POST | /api/tia/preflight | JWT + localOnly | 写入前预检，生成事实摘要和确认 token |
| POST | /api/tia/import | JWT + localOnly | 消费一次性确认 token 后写入/编译 |
| GET | /api/tia/history | JWT | 写入历史列表 |
| GET | /api/tia/history/:id | JWT | 读取单条历史 |

写入顺序不可省略：内容完整性 → 语言/结构 → BOM/CTU_INT/S7DCL MLC 规则 → 预检事实 → 用户确认 → 后端消费一次性 token → 全局队列 → 导入/编译/历史记录。不能只用 confirmed:true 放行。

## 6. TIA MCP 路由

server.js 必须先挂：

~~~text
app.use('/api/tia/mcp', createTiaMcpRoutes(deps));
app.use('/api/tia', createTiaRoutes(deps));
~~~

若先挂较宽的 /api/tia，/api/tia/mcp/* 可能被错误吞掉。验收应检查 mcp/status 不是 404、tia/history 不是 404、敏感静态文件拦截仍在 static 之前。

| 方法 | 路径 | 保护 | 作用与边界 |
|---|---|---|---|
| GET | /api/tia/mcp/status | JWT + localOnly | MCP 子进程、TIA 根路径、预热状态 |
| GET | /api/tia/mcp/tools | JWT + localOnly | 工具清单，只读列出危险标记 |
| POST | /api/tia/mcp/connect | JWT + localOnly | 连接当前已打开工程 |
| GET | /api/tia/mcp/software-tree | JWT + localOnly | 读取软件树 |
| POST | /api/tia/mcp/describe-block | JWT + localOnly | 只读解读块逻辑 |
| POST | /api/tia/mcp/call | JWT + localOnly | 通用工具调用；危险工具须满足后端确认条件 |
| POST | /api/tia/mcp/search-hardware | JWT + localOnly | SearchHardwareCatalog 包装，结果最多 50 条 |
| POST | /api/tia/mcp/tag-tables | JWT + localOnly | GetPlcTagTables 包装 |
| POST | /api/tia/mcp/export-s7dcl | JWT + localOnly | ExportBlocksAsDocuments 包装，导出前仍按只读处理 |
| POST | /api/tia/mcp/scaffold | JWT + localOnly | ScaffoldProject；先 dryRun，执行须明确确认 |

MCP 客户端负责常驻子进程、JSON-RPC、超时终止和下次重启。TIA MCP 与 EngineerYin 共用队列，避免连接/写入/编译并发冲突。

## 7. 静态资源与敏感文件

- server.js 在静态资源前拒绝 .env、数据库、日志及敏感构建入口。
- 生产环境不要把 .env、plc_assistant.db、license.json 或 work/logs 放到可下载目录。
- 绿色包故意不含 server.js、package.json 和开发 node_modules；源码交接包只来自 git archive 并执行敏感文件排除。

## 8. 修改前安全清单

- [ ] 新路由同时保留正确 JWT/管理员门禁和 localOnly。
- [ ] 所有 TIA 操作仍进入全局队列。
- [ ] 写入、回滚、下载、建工程和危险 MCP 调用仍有事实确认与一次性 token。
- [ ] 未改 BOM、CTU_INT、S7DCL MLC、互斥队列和三级弹窗。
- [ ] 响应与日志不泄露 Key、数据库、授权文件、绝对路径和堆栈。
- [ ] 改动后跑结构测试、单测和真实只读验证。

## 9. 维护入口

- 挂载与启动：server.js
- 认证：lib/auth.js
- TIA 写入：routes/tia.js
- MCP：routes/tia-mcp.js、tia-mcp-client.js
- 队列：lib/tia-queue.js
- 密钥加密：crypto-util.js
- 退出：lib/launcher-shutdown.js 与 server.js
- 测试：test/*.test.js
