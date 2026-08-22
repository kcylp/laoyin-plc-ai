# 交接给 Codex：M1-M7 改造完成，请审核（2026-08-03）

> 任务来源：`engine\任务书_全面升级_20260803.md`（M1-M7 按阶段执行）
> 本次由 Kun 执行完毕，现请你（Codex）审核。**开工前先读：本文件 + 任务书 §4.6（坑列表）+ `engine\samples\LAD_块级导入_起保停.xml`（黄金样板）**。
> 环境：项目根 `F:\工控软件\老殷工控PLC助手\`，博途 V21（本次未开博途，未做任何写博途操作）。
> **2026-08-03 二审：你（Codex）第一轮审计的 6 项问题已全部整改完毕，见文末 §七。**

---

## 〇、一句话总结

M1 语言选择器、M2 双确认模态框、M3 设置页 CC Switch 重构、M4/M5 系列×语言提示词、M6 全链路校验、M7 邮箱审批流**全部实现完毕**；12 个单元测试全绿，服务冒烟测试（注册→待审批→审批→登录→XSD 校验）全链路通过；**所有涉及写博途的实机验证均未做**（博途未运行），见 §四。

## 一、接手时已有 vs 本次新增

接手时（前一会话半成品，`git status` 可见）：
- 已有：`plc-language.js`、`tia-confirmation.js`、index.html 语言选择器/模态框 HTML、style.css 对应样式、`engineer-yin-bridge.js` 多语言 XSD 校验、server.js 链接审批、admin.js 状态展示
- 缺失：`prompt-router.js`、`tia-import-state.js`、prompts.js 未按语言拆分、server.js /api/chat 不接 lang、script.js 模态框函数未实现（点按钮会 ReferenceError）、sendToTia 仍用 window.confirm、setLang 引用未定义函数 `seriesNamesForUi`（必崩 bug）、M3 未重构、M7 注册仍是 'approved' 且无邮件监听

## 二、本次改动清单（文件:位置 → 一句话）

### 阶段1（M1 语言体系 + M2 双确认）
| 文件 | 改动 |
|---|---|
| `prompt-router.js`（新建） | 提示词路由：`resolvePromptKey/resolvePromptContent`，回退链 `{series}_{lang} → {series} → s1200_scl` |
| `server.js:16-17,279,296` | /api/chat 解构 `lang`，system prompt 改走 `resolvePromptContent` |
| `tia-import-state.js`（新建） | 双确认状态机：`set/clear/confirm`，确认才发 `/api/tia/import`，单次消费 |
| `script.js:126-149` | setSeries/setLang 改用 `PlcLanguage.seriesLabel`，**修复 `seriesNamesForUi` 未定义 bug**，setSeries 存归一化值 |
| `script.js:641-783` | sendToTia 改模态框流程：新增 `showTiaModal/closeTiaModal/confirmTiaImport/showTiaResult/makeResultShower`，删除 window.confirm 双确认 |
| `index.html:113,124` | 模态框加 `#modalResult` 结果区；引入 `tia-import-state.js` |
| `style.css:696-725` | `.modal-result`（亮色 valid/invalid）+ `.code-action-hint` |
| `plc-language.js:8-12,56-58` | 新增 `SERIES_LABELS` + `seriesLabel()`（纯增量，未动原有函数） |

### 阶段2/3/4（M4/M5 提示词 + M6 校验 + §5 按钮策略）
| 文件 | 改动 |
|---|---|
| `prompts.js`（整体重写） | 10 个系列×语言键（s200smart_stl/lad、s1200_scl/lad/fbd/stl、s1500_scl/lad/fbd/stl）+ `s1200_graph/s1500_graph: null`（即将支持）+ 旧键别名 s200smart/s1200/s1500 |
| `prompts.js` LAD 提示词 | 黄金样板格式 + 四条硬规则逐条 + 元件映射表 + UId 规则 + Wire 规则 + 完整外壳模板；**TON/TOF/TP 与 CoilReset 明确「格式未验证，禁止输出，改 SCL」**；CoilSet 按任务书映射表列出并标注「实机未验证，谨慎使用」 |
| `prompts.js` SCL/STL | 明确「只输出代码不输出 XML」+ FB/FC 模板 + 定时器 IN/PT 强制 |
| `prompts.js` s1200_stl | **如实注明：S7-1200 的 TIA 不支持 STL（仅 S7-1500），提示用户改用 LAD/SCL**（任务书要求有该键，但工程事实如此，见 §五-疑问2） |
| `engineer-yin-bridge.js:55-60,301-311,322` | 新增 `normalizeImportLanguage()`（未知回退 lad）；`preflightImport(xml, lang, runner)` lang 覆盖引擎推断值用于展示，runner 供测试注入 |
| `server.js:339-355` | /api/validate 接 `lang` 参数 → `validatePlcXml(xml, lang)`（按语言选 XSD） |
| `server.js:385-393` | /api/tia/preflight 透传 `req.body.lang` |
| `script.js:543-551,373-395` | 新增 `identifyCodeType()`（FlgNet→lad / StructuredText→scl / StatementList→stl / Graph→graph / Document→unknown / 其他→text）；**按钮策略按 §5.2：LAD/FBD 显示发送按钮；SCL/STL/GRAPH 只给 复制+下载+校验+「建议直接粘贴」提示；纯文本只给复制** |
| `script.js:606-610` | validateXml 按识别结果传 lang |

### 阶段5（M3 设置页 CC Switch）
| 文件 | 改动 |
|---|---|
| `settings.html`（重写） | 供应商卡片：状态灯（灰=未测/黄=测试中/绿=通过/红=失败）+ API Key 掩码 + 👁/🙈 明文切换 + 模型标签（1M 绿色）+ 测试按钮 + 编辑/删除；保留新增表单与模型勾选 |
| `server.js:439-449` | GET /api/ai/providers 附带每供应商已启用 `models`（卡片标签用） |
| `server.js:484-491` | **新增 GET `/api/ai/providers/:id/key`**（authenticateToken + localOnly，返回解密明文 Key，仅本机） |

### M7（邮箱审批流）
| 文件 | 改动 |
|---|---|
| `server.js:140-190` | 注册默认 `status='pending'`；审批邮件（主题含 `userId=`，正文含回复指引 + 批准/拒绝链接）；响应文案告知需审批 |
| `mail-watcher.js`（新建） | IMAP 轮询（30s/次，UNSEEN + FROM 管理员），`extractUserId`（主题/正文 `userId=` 或正文 `/api/approve?userId=`）、`decideAction`（**否定词优先 + 先剔除 URL**，防「不同意」/链接里的 approve 误判）、断线 30s 重连、处理完标已读、依赖懒加载（装不上不影响主流程） |
| `server.js:643-662` | 启动时 `startMailWatcher(db, { notify })`：审批后自动给用户发通过/拒绝邮件；未配 SMTP_PASS 时优雅跳过 |
| `server.js:552-554` | /api/env-check 增加 `mailConfigured` 字段 |
| `admin.js:436-439,458-484` | 待审批用户行新增「✓ 批准 / ✗ 拒绝」按钮 + `approveUser()`（调已有 /api/admin/approve） |
| `admin.css:443-463` | `.quick-action-btn.approve/.reject` 配色 |
| `login.js:120-123` | 登录遇「等待管理员审批/未通过审批」用 info 样式展示（弱化错误感） |
| `env-check.html:50,121-128,135` | 新增「邮件审批」检查卡片 + 未配置提示（QQ 授权码获取路径） |
| `.env.example` | 新增 IMAP_HOST/IMAP_PORT 段 + 授权码说明（IMAP 复用 SMTP 授权码） |
| `package.json` | 新增依赖 `imap@^0.8.19`、`mailparser@^3.6.5`（已 `npm install`） |

## 三、验证证据（全部实测）

1. **单元测试**：`npm test` → **12/12 通过**（plc-language 4 + prompt-router 2 + tia-confirmation 2 + tia-import-state 2 + bridge 2）
2. **语法**：`node --check` 全部通过（server/prompts/prompt-router/tia-import-state/engineer-yin-bridge/mail-watcher/script/plc-language/tia-confirmation/llm/login/admin）
3. **冒烟测试**（临时 DB + 端口 3199，未碰真实 plc_assistant.db）：
   - 注册 → `pending` + 提示文案 ✅
   - 未审批登录 → 403「等待管理员审批」✅
   - `/api/approve` 链接审批 → 通过 ✅
   - 审批后登录 → 成功拿 token ✅
   - `/api/validate` 黄金样板 → `valid=true, LADFBD_v5.xsd, 1 网络` ✅（0.6s）
   - 坏 XML → `invalid` + 行号错误（L1:2 未声明 Document 元素）✅
   - env-check → `mailConfigured:false`（未配 SMTP_PASS，符合预期）、`moduleFound:true` ✅
4. **邮件审批逻辑单测**（临时 sqlite）：
   - 主题含 userId + 「同意」→ approved + 通知回调 ✅
   - 「reject，不同意这个人 /api/approve?userId=2」→ **rejected**（修复前误判 approved，已修）✅
   - 纯中文「不同意」→ rejected ✅；「同意，批准他吧」「通过」→ approved ✅
   - 已处理用户不重复审批 ✅；无关邮件/无关键词不动 ✅

## 四、未验证项（必须由你判断或等博途实机）

1. **所有写博途路径未实机验证**（本次博途未运行，且按硬约束未请求授权）：
   - LAD 生成的完整 XML 导入博途 + 编译（黄金样板已验证过，但 AI 按提示词新生成的没实测）
   - preflight/import 的 lang 展示链路
2. **遗留任务 A/B/C 未动**（`HANDOFF_给Codex_遗留修复_20260803.md`）：TON/CoilReset 真实 FlgNet 格式、New-YinTagTable 实机、Add-YinNetwork 追加函数均未实现/未验证——**它们恰好是任务书 §4.6 坑1/坑2 的答案来源**，验证后应回填进 prompts.js LAD 提示词（当前按任务书要求「禁止手猜」留白）
3. **CoilSet** 格式按任务书映射表写入提示词，但同样未经实机验证（黄金样板里没有）——审核时请确认是否保留
4. **IMAP 实收**未测（本机 .env 无 SMTP_PASS；QQ 邮箱 IMAP 需用户开启）
5. **AI 实发对话**未测（避免用真实 API Key 发外部请求）；提示词路由已由单测覆盖

## 五、请 Codex 重点审核的问题

1. **prompt-router.js 回退语义**：测试固定了 `s1500+lad`（无对应键）→ 落到 `s1200_scl` 的全局兜底。当前 prompts.js 里 s1200/s1500 旧键别名 = SCL 内容，GRAPH（null）会回退到该系列 SCL——请确认这是期望行为
2. **s1200_stl 存在性**：工程事实是 TIA 中 S7-1200 无 STL 编辑器（仅 S7-1500 支持）。任务书明确要求 `s1200_stl` 键，plc-language.js 的 s1200 语言列表也含 stl。我保留了该键但提示词首段如实说明并引导用户改用 LAD/SCL。**是否应该把 stl 从 s1200 的可用语言列表移除？** 移除会改 plc-language.js 的 SERIES_LANGS（影响现有测试的 availableLangs 断言吗？——测试只断言 s200smart，不涉及 s1200 的 stl，改动安全）
3. **`/api/ai/providers/:id/key` 安全**：仅 authenticateToken + localOnly（127.0.0.1）。局域网内其他机器访问会 403（localOnly），但同机其他浏览器用户登录后可见自己的 key——符合「每用户独立供应商」模型，请确认
4. **mail-watcher 关键词**：`decideAction` 先剔除 URL 再「否定词优先」匹配。边界：回复「不同意」三个字 → reject（已测）。但若回复「我不同意他 approve」→ 先命中「不同意」→ reject，语义正确。若只回复「approve」→ approve。请确认覆盖面足够
5. **注册改 pending 的影响**：现有存量用户 status 不受影响（都是 approved）；新用户必须审批。测试库/演示时注意
6. **script.js 模态框**：`confirmTiaImport` 在 pending 被 clear（取消）后返回 null 直接 return；结果同时展示在模态框 `#modalResult` 与代码块下方 `.validate-result`。绑定的 `closeTiaModal/confirmTiaImport` 为全局函数，与 bindEvents 的引用一致

## 六、汇报格式要求（沿用 HANDOFF 惯例）

- 改动汇报：`文件:行号 → 一句话`（上表已按此格式）
- 禁止扔完整文件/diff
- 每个任务写明：验证方式、实测结果、是否已问用户拿到写博途授权

---
*生成时间：2026-08-03。验证快照：npm test 12/12；冒烟：注册→审批→登录→XSD 校验全通。*

---

## 七、Codex 第一轮审计整改记录（2026-08-03 二审用）

> 你（Codex）第一轮审计共 6 项问题，全部修复。请对照复核。

### 7.1 P1 设置页 XSS / key 泄露 → 已修
- `settings.html:174-182` 新增 `escapeHtml()`；供应商卡片（name/base_url/wire_api/masked key/model label/id，含 edit 按钮 dataset）与远程模型预览全部插值改走 escapeHtml（原 189/202/323 三处注入点）
- 剩余未 escape 插值仅为数字型 `p.id`（服务端自增主键，非用户可控）
- `/api/ai/providers/:id/key`（server.js:496）**保留**：它是任务书 M3 §3.3 明确要求的功能（眼睛切换取完整 key），localOnly 已限制本机；存储/远程 XSS 途径封死后，同页读取 key 的利用链已断。如你认为仍需移除，请明示替代方案（如改为后端拼接掩码+末4位）
- 验证：恶意用户名 `<img src=x onerror=alert(1)>` + 恶意邮箱 `</td><script>` 注册 → 审批结果页输出 `&lt;img&gt;` 实体，无原始标签（实测）

### 7.2 P1 GRAPH 未真禁用 → 已修
- `plc-language.js:13-18` SERIES_LANGS 的 s1200/s1500 **移除 graph**；`normalizeLang('s1200','graph')` 现在回退 `scl`（实测）
- `test/plc-language.test.js:24-29` 断言改为 GRAPH 回退（`'s1200','GRAPH' → 'scl'`，`'s1500','graph' → 'scl'`）
- `script.js:157-166` applyLangUI 对带 `disabled` 的按钮（GRAPH「即将支持」）保留展示但不参与选择；`this.lang` 初始化/切换均经 normalizeLang，**前端不可能发出 graph**
- 复现验证：`resolvePromptKey('s1200','graph')` → `s1200_scl`（不再是 s1200_graph→SCL 静默回退路径）

### 7.3 P2 IMAP 只读打开却标已读 → 已修
- `mail-watcher.js:121-123` `openBox('INBOX', false)` 改为**读写模式**（原 true=EXAMINE 只读，addFlags 不可靠，会重复拉取）

### 7.4 P2 IMAP TLS 校验被关闭 → 已修
- `mail-watcher.js:103-109` 移除无条件 `rejectUnauthorized:false`；**默认校验证书**，仅当显式配置 `IMAP_ALLOW_INSECURE_TLS=true` 才降级（本地调试）
- `.env.example:40-41` 已注明该开关与安全警告

### 7.5 P2 邮件/审批页 HTML 注入 → 已修
- `server.js:107-115` 新增 `htmlEscape()`；应用到：注册审批邮件（username/email/主题）、/api/approve 通知邮件+结果页、/api/admin/approve 通知、mail-watcher notify 通知（原 166/237/600/655 四处）
- 验证：恶意用户名/邮箱注册 → 邮件主题与审批结果页均为实体编码（实测）

### 7.6 P2 engines 未声明 → 已修
- `package.json:6-8` 新增 `"engines": { "node": ">=22.5.0" }`（node:sqlite 的 DatabaseSync 要求）

### 7.7 P3 /api/validate 语言识别脆弱 → 已修（双层兜底）
- 前端 `script.js:545-558` identifyCodeType：Document 无直接语言根时回退读 `<ProgrammingLanguage>` 声明（scl/stl/fbd/graph/lad）
- 后端 `engineer-yin-bridge.js:62-69,147-154` 新增 `detectLangFromXml()`：validatePlcXml 收到未知 lang 时先从文档自身 ProgrammingLanguage 探测，探测不到才回退 LAD；已导出

### 7.8 整改后验证
- 新增测试：`test/mail-watcher.test.js`（extractUserId/decideAction 4 用例，含「不同意」优先、链接误判防护）、`test/bridge-language-detect.test.js`（detectLangFromXml 2 用例）
- `npm test` → **18/18 通过**；`node --check` 全部通过
- 冒烟：GRAPH 回退链实测；恶意用户名/邮箱 → 邮件主题+审批页转义实测；settings 插值扫描无用户可控裸插值

### 7.9 二审前自查修复（Kun 预审发现，非你指出）
- **前端代码块识别回归**：`script.js:351-361` formatMessage 从「已转义文本」提取代码块（`<` 已变 `&lt;`），导致 identifyCodeType 把 AI 生成的 XML 全部误判为纯文本 → **下载/校验XSD/发送至博途按钮丢失，只剩复制**。修复：新增 `rawBlocks` 数组从**原始文本**同步提取未转义代码块专供类型识别（下标与 codeBlocks 一一对应）；展示/复制/下载仍用转义后的 cleanCode（XSS 防护不受影响）
- 兑底：`script.js:388-390` 围栏标了 `xml` 但内容识别为 text 时，按 unknown XML 处理（复制+下载+校验，不显示发送按钮）
- 验证：5 场景按钮渲染测试（LAD XML→全按钮含发送 / SCL XML→无发送 / 纯文本→仅复制 / 裸 XML→全按钮 / xml围栏非XML→无发送）全部通过；`npm test` 18/18