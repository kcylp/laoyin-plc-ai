---
id: "comm-s7"
title: "S7 通信（PUT/GET）"
标题: "S7 通信（PUT/GET）"
category: "通信"
分类: "通信"
keywords: ["S7", "PUT", "GET", "通信"]
关键词: ["S7", "PUT", "GET", "通信"]
applies_to: ["S7-1200", "S7-1500", "S7-200SMART"]
适用: ["S7-1200", "S7-1500", "S7-200SMART"]
difficulty: "高级"
难度: "高级"
generation_status: "none"
可生成性: "none"
generation_mark: "none"
instructions: ["PUT", "GET"]
example_requests: ["S7 PUT/GET 通信：CPU1515 作为客户端，PUT 数据到 CPU1214 的 DB。S7-1500。", "注意：SetPutGetAccess 是危险工具，需 TASK-006 白名单授权后才能自动生成通信块。"]
review_status: "pending"
source: "知识库_积木库正文_草稿待审.md"
---
## 6.1　S7 通信（PUT / GET）

**id** `comm-s7`

### 名称/别名
**中文**：S7 通信 · PUT/GET · S7 单边通信 · PLC 间通信 · S7 连接
**英文**：S7 Communication · PUT/GET · S7 Single-sided Communication

### 适用场景
两台西门子 PLC（S7-1200/1500/300/400）之间交换数据。`PUT` 写对方、`GET` 读对方，属**单边通信** —— 只需在一侧编程，对方不用写通信程序（但需允许被访问）。

### 🔴 双重障碍：块调用 + 一个危险工具

**障碍一：块调用。** `PUT` / `GET` 是**带背景 DB 的 FB 调用**，`<Call>` 全项目零实例（《技术底座》第三节）→ **XML 写不出来。**

**障碍二：`SetPutGetAccess` 是危险工具（TASK-006）。**
要让对端 PLC 允许被 PUT/GET 访问，需在对端 CPU 属性里勾选「允许来自远程对象的 PUT/GET 通信访问」。用 Openness 自动改这个设置的工具在 TASK-006 里被标为**危险**。
**→ 本知识库的立场：这个开关涉及安全边界（等于允许远端无认证读写本机数据区），必须由人明确决定并留痕，不许 AI 自动勾。**

### 梯形图逻辑描述（模式 + 手工添加指引）

```
Network 1: 通信触发（✅ 可生成）—— 周期触发，不要每周期都发
  常开[通信节拍]  →  T_CommTick(IN)，PT = 通信周期
  常开[T_CommTick.Q] → PBox → SCoil[通信Req]，RCoil[通信节拍]（自复位重启）

Network 2: 【🔴 手工添加】PUT / GET
  REQ    ← [通信Req]
  ID     ← 连接 ID（在「连接」组态里建立 S7 连接后得到）
  ADDR_1 ← 对方数据区地址（P# 指针形式）
  SD_1 / RD_1 ← 本地发送/接收数据区
  输出：DONE / NDR / ERROR / STATUS

Network 3: 结果处理（✅ 可生成，必须边沿 —— DONE/NDR 通常只置一周期）
  常开[PUT.DONE] → PBox → RCoil[通信Req]，Move(0)→[通信失败计数]
  常开[GET.NDR]  → PBox → RCoil[通信Req]，Move(0)→[通信失败计数]
  常开[ERROR]    → PBox → Move([STATUS])→[通信状态码]，Add([通信失败计数],1)

Network 4: 通信超时（✅ 可生成）
  常开[通信Req]  →  T_CommTmo(IN)，PT = 通信超时
  常开[T_CommTmo.Q]  →  SCoil[Alm_Comm]，RCoil[通信Req]

Network 5: 连续失败判定（✅ 可生成）
  Ge([通信失败计数], [失败次数阈值])  →  SCoil[Alm_CommLost]
      →  【关键】把所有来自对端的数据标为"不可信"，联锁进安全逻辑
```

**手工添加指引（用户在博途里做的部分）**

1. **建 S7 连接**：设备视图/网络视图 → 连接 → 选「S7 连接」→ 从本机拉到对端 → 得到**连接 ID**。
2. **对端必须允许 PUT/GET**：对端 CPU 属性 → 防护与安全 → 连接机制 → 勾选「允许来自远程对象的 PUT/GET 通信访问」。
   ⚠️ **这是一个安全决策**，等于允许远端无认证读写数据区。**必须由人决定并在交付文档留痕。**
3. 插入 `PUT` / `GET`（通信指令 → S7 通信），接受创建背景 DB。
4. `ADDR_1` 填对方地址（指针形式），`SD_1`/`RD_1` 填本地数据区。**长度必须匹配**。
5. **`REQ` 用沿触发，不要常为真**。

### 变量表

| 名称建议 | 数据类型 | 方向/存储区 | 说明 |
|---|---|---|---|
| `通信Req` / `Comm_Req` | Bool | M | **沿触发，不要常真** |
| `连接ID` / `Conn_ID` | Word | DB | 来自连接组态 |
| `发送数据区` / `Comm_Send` | UDT / ARRAY | DB | |
| `接收数据区` / `Comm_Recv` | UDT / ARRAY | DB | |
| `PUT/GET实例` | PUT / GET | 背景 DB | 🔴 手工 |
| `通信状态码` / `Comm_Status` | Word | DB | 存 STATUS，供诊断 |
| `通信失败计数` / `Comm_ErrCnt` | Int | DB | |
| `失败次数阈值` / `Comm_ErrLim` | Int | DB | |
| `Alm_Comm` / `Alm_CommLost` | Bool | DB | 锁存报警 |
| `对端数据可信` / `Peer_Valid` | Bool | M | **必须有** —— 通信断时数据不可信 |
| `通信节拍/超时定时` | IEC_TIMER | FB→Static | |

### 参数与整定

| 参数 | 建议初值 | 依据 |
|---|---|---|
| **通信周期** | **视工艺定** —— 由数据时效性需求定；不要比需要的更快 | 过快占网络带宽与 CPU 时间 |
| **通信超时** | **请求周期 × 3，且 ≥ 500 ms** | 留出网络抖动（《整定值》2.6） |
| 连续失败阈值 | 3–5 次 | 单次失败可能是抖动，连续失败才是真断 |
| 数据区长度 | **必须与对端一致** | 长度不匹配是 PUT/GET 最常见的失败原因 |

### 常见坑　⚠️【待老殷审】

- 🔴 **`REQ` 常为真** → 每周期发一次请求，网络与 CPU 被打满，且 `DONE`/`NDR` 状态错乱。**必须沿触发。**
- 🔴 **`DONE` / `NDR` / `ERROR` 用轮询** → 这类状态位**通常只置一个扫描周期**（与运动控制指令同类问题）。**必须边沿捕获。**
- 🔴 **通信断了但程序继续用旧数据** → 对端数据停在最后一次成功的值，程序以为一切正常。
  **→ 必须有「对端数据可信」标志，通信断时把它清掉，并联锁进控制逻辑。** 这是通信类需求的头号安全问题。
- 🔴 **对端未允许 PUT/GET 就调试** → 一直报错，很多人在这上面卡半天。**先确认对端设置。**
- **收发数据区长度不匹配** → PUT/GET 失败或读到错位的数据。**长度必须两侧核对。**
- **优化访问的 DB 用 P# 指针** → 【本机】
  EN: `Absolute access to data in blocks with optimized access is not permitted.`（`BL_PARSE_11A5`）
  ZH: `不允许在具有优化访问的块中对数据进行绝对寻址。`
  EN: `You cannot access an optimized memory area from this location.`
  ZH: `该引用未指向一个已优化的块。`（EN: `The reference does not point to an optimized data block.`）
  → **PUT/GET 的 `ADDR_1` 用的是指针（绝对寻址），因此涉及的 DB 通常需设为「标准访问」（非优化）。** 这是 PUT/GET 最常撞的墙。
- 🔴 **优化/标准混用的隐藏行为** —— 官方 PG 原文：混用时**参数一律退化为拷贝传递，回写发生在块调用结束之后**，且**编译不报错**。这是"块内改了值但外面没同步"的根因。
  相关报错【本机】：EN: `Source and export block have to have the same block access type…`（准确原文为 `Source and target block have to have the same block access type (optimized access or standard access).`，KEY `ERR_PA_SEM_BlockAccess`）/ ZH: `源块和目标块的块访问方式必须相同（优化访问或标准访问）。`
- **背景 DB 相关报错**【本机】：`Instance data block does not match called FB.` / `背景数据块与被调用 FB 不匹配。`；`Time stamp conflict of the instance data block.` / `背景数据块时间戳冲突。`；`背景数据块缺失。`
  ⚠️ 社区流传的 `The instance ... is not defined` / `A block instance must be assigned` **已判定为伪造**。
- **`STATUS` 不记录** → 通信出问题时无从诊断。**必须存 STATUS 并在 HMI 可查。**
- **通信数据直接驱动安全联锁** → 通信有延迟、有丢包。**安全功能绝不经通信**（与 4.2 同理，标准 PLC + 标准网络达不到 PL c）。
- **不做安全边界评估就开 PUT/GET** → 允许远程无认证读写，等于在网络上开了一个口。**必须评估网络隔离、访问控制，并在交付文档留痕。**

### 上机前必须确认　⚠️【待老殷审】

- [ ] `REQ` **用沿触发**（不常真），周期已按数据时效性需求设定
- [ ] `DONE` / `NDR` / `ERROR` **用边沿捕获**
- [ ] **「对端数据可信」标志已实现**，通信断时清掉，并联锁进控制逻辑（**实测：拔网线，确认程序不再用旧数据**）
- [ ] 对端 CPU **已允许 PUT/GET 访问**，且该决定已**由人书面确认并在交付文档留痕**（这是安全边界决策）
- [ ] 收发数据区**长度两侧核对一致**
- [ ] 涉及的 DB 访问类型（**优化 / 标准**）与指针寻址方式匹配，调用链上一致
- [ ] `STATUS` 已存进 DB 并可在 HMI 查看
- [ ] 通信超时 = 请求周期 × 3 且 ≥ 500 ms，并实测触发
- [ ] 连续失败阈值已设，且失败后行为（报警/停机/降级运行）已与甲方确认
- [ ] **安全功能不经通信**　【惯例，本项目强制】
- [ ] 网络隔离与访问控制已评估（开 PUT/GET 等于开放数据区读写）
- [ ] `SetPutGetAccess` 类自动化工具**未被用于自动勾选该开关**（TASK-006 标为危险）

### 可生成性
**🔴 暂不可自动生成 —— 等 TASK-012A 实证，当前只可人工编写。**
根因：`PUT` / `GET` 是带背景 DB 的 FB 调用，`<Call>` 零实例。
✅ **可生成的部分**：通信触发节拍（`TON` + `PBox`）、结果的边沿捕获、失败计数（`Add`/`Ge`）、超时、**「对端数据可信」标志与联锁**（这一条最有价值，是通信类需求的头号安全项）。
⚠️ **额外声明**：`SetPutGetAccess`（自动勾选对端 PUT/GET 允许位）在 TASK-006 中标为**危险工具**。本知识库立场：**该开关必须由人决定并留痕，不许自动改。**

---
