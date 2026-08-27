---
id: "comm-modbus"
title: "Modbus TCP/RTU"
标题: "Modbus TCP/RTU"
category: "通信"
分类: "通信"
keywords: ["Modbus", "TCP", "RTU", "通信"]
关键词: ["Modbus", "TCP", "RTU", "通信"]
applies_to: ["S7-1200", "S7-1500", "S7-200SMART"]
适用: ["S7-1200", "S7-1500", "S7-200SMART"]
difficulty: "高级"
难度: "高级"
generation_status: "none"
可生成性: "none"
generation_mark: "none"
instructions: ["MB_CLIENT", "MB_SERVER"]
example_requests: ["Modbus TCP 读写变频器：MB_CLIENT 读保持寄存器 40100 获得转速反馈。S7-1200。", "Modbus RTU 串行通信：CM1241 模块，读温度变送器 04 功能码。"]
review_status: "pending"
source: "知识库_积木库正文_草稿待审.md"
---
## 6.2　Modbus TCP / RTU

**id** `comm-modbus`

### 名称/别名
**中文**：Modbus 通信 · Modbus TCP · Modbus RTU · 串口通信 · 第三方设备通信
**英文**：Modbus TCP / RTU · MB_CLIENT / MB_SERVER · Modbus_Master / Modbus_Comm_Load

### 适用场景
与第三方设备通信：变频器、仪表、称重模块、温控表、电力仪表、其他品牌 PLC。**这是实际工程中最高频的通信需求**（比 S7 通信更常见，因为第三方设备大多支持 Modbus）。

### 🔴 为什么暂不可自动生成

Modbus 相关指令全部是**带背景 DB 的 FB 调用**：
- **Modbus TCP**：`MB_CLIENT`（主站）/ `MB_SERVER`（从站）
- **Modbus RTU**：`Modbus_Comm_Load`（端口初始化，**必须先调**）/ `Modbus_Master` / `Modbus_Slave`

`<Call>` 全项目零实例 → **XML 写不出来。**

### 梯形图逻辑描述（模式 + 手工添加指引）

```
Network 1: 【🔴 手工添加，且必须在最前】Modbus_Comm_Load（仅 RTU）
  ⚠️ RTU 必须先用 Modbus_Comm_Load 初始化端口（波特率、校验、端口号），
     且通常在首次扫描 OB100 或用首扫描位调一次。TCP 不需要这一步。

Network 2: 请求轮询调度（✅ 可生成）—— 一次只能有一个请求在飞
  常开[允许通信] 串联 常闭[请求进行中]
      →  线圈[发起下一请求]
  常开[发起下一请求] → PBox
      →  Add([请求序号], 1) → [请求序号]
      →  Ge([请求序号], [请求总数]) → Move(1) → [请求序号]     ← 回绕
      →  SCoil[请求进行中]

Network 3: 按请求序号装载参数（✅ 可生成）
  Eq([请求序号], 1) → Move(3)→[功能码]，Move(0)→[起始地址]，Move(10)→[数据长度]
  Eq([请求序号], 2) → Move(3)→[功能码]，Move(100)→[起始地址]，Move(4)→[数据长度]
  …

Network 4: 【🔴 手工添加】MB_CLIENT / Modbus_Master
  REQ / REQUEST     ← [请求进行中]
  MB_MODE / MODE    ← 读/写模式
  MB_DATA_ADDR      ← [起始地址]
  MB_DATA_LEN       ← [数据长度]
  MB_DATA_PTR       ← 本地数据区指针
  CONNECT（TCP）    ← 连接参数 DB（TCON_IP_v4 类型）
  输出：DONE / BUSY / ERROR / STATUS

Network 5: 结果处理（✅ 可生成，必须边沿）
  常开[DONE] → PBox → RCoil[请求进行中]，Move(0)→[失败计数]
  常开[ERROR] → PBox → RCoil[请求进行中]，Move([STATUS])→[通信状态码]
      →  Add([失败计数],1)

Network 6: 超时 + 连续失败 + 数据可信标志（✅ 可生成，同 6.1）
  常开[请求进行中] → T_MbTmo(IN)，PT = 超时
  常开[T_MbTmo.Q] → SCoil[Alm_Modbus]，RCoil[请求进行中]
  Ge([失败计数], [阈值]) → SCoil[Alm_ModbusLost]，RCoil[从站数据可信]
```

**手工添加指引要点**

1. **RTU 必须先 `Modbus_Comm_Load`**（波特率、校验位、端口硬件标识），且**只需在首次扫描调一次**（或参数变化时）。**漏了这一步，Master 一直报错。**
2. **TCP 需要 `CONNECT` 连接参数**（`TCON_IP_v4` 结构，含对端 IP、端口 502、连接 ID）。
3. **一个 `MB_CLIENT` 实例同一时刻只能有一个请求在飞** → 多个请求必须**轮询调度**（Network 2/3 的作用）。
4. **多个从站**：TCP 下可用多个 `MB_CLIENT` 实例（每个连一个从站），或一个实例切换 CONNECT（需断开重连，慢）。
5. **Modbus 地址与博途地址的偏移**：Modbus 文档常用 1-based（40001 = 保持寄存器 0），博途的 `MB_DATA_ADDR` 用的是 Modbus 协议地址。**必须与设备手册逐项核对，这是最常见的错源。**

### 变量表

| 名称建议 | 数据类型 | 方向/存储区 | 说明 |
|---|---|---|---|
| `请求序号` / `Mb_ReqIdx` | Int | DB | 轮询调度 |
| `请求总数` / `Mb_ReqQty` | Int | DB | |
| `请求进行中` / `Mb_Busy` | Bool | M | **一次只许一个** |
| `功能码` / `Mb_Mode` | Int / USInt | DB | 读/写 |
| `起始地址` / `Mb_Addr` | UDInt | DB | ⚠️ 地址偏移必须核对 |
| `数据长度` / `Mb_Len` | UInt | DB | |
| `从站数据区` / `Mb_Data` | ARRAY OF Word / UDT | DB（**标准访问**，因用指针） | |
| `MB_CLIENT实例` | MB_CLIENT / Modbus_Master | 背景 DB | 🔴 手工 |
| `连接参数` / `Mb_Conn` | **TCON_IP_v4** | DB | 仅 TCP |
| `通信状态码` / `Mb_Status` | Word | DB | 存 STATUS |
| `失败计数` / `Mb_ErrCnt` | Int | DB | |
| `从站数据可信` / `Slave_Valid` | Bool | M | **必须有** |
| `Alm_Modbus` / `Alm_ModbusLost` | Bool | DB | 锁存报警 |

### 参数与整定

| 参数 | 建议初值 | 依据 |
|---|---|---|
| **通信超时** | **请求周期 × 3，且 ≥ 500 ms** | 留网络抖动（《整定值》2.6）。RTU 串口更慢，需加大 |
| 轮询周期 | **视工艺定** —— 由数据时效性定 | 不要比需要的更快；RTU 波特率低时轮询太快会积压 |
| RTU 波特率 / 校验 / 停止位 | **必须与从站设备手册一致** | 设备参数 |
| RTU 从站响应超时 | 查设备手册，通常 100 ms ~ 1 s | 设备参数 |
| 连续失败阈值 | 3–5 次 | 同 6.1 |
| Modbus 寄存器地址 | **必须与设备手册逐项核对** | ⚠️ **地址偏移（0-based / 1-based）是最常见错源** |
| 数据字节序 | **必须与设备手册核对**（大端/小端、字序） | 32 位值跨两个寄存器时，字序错了读出来是天文数字 |

### 常见坑　⚠️【待老殷审】

- 🔴 **RTU 漏调 `Modbus_Comm_Load`** → Master 一直报错，且报错信息不直观。**必须先初始化端口。**
- 🔴 **同一实例同时发多个请求** → 一个 `MB_CLIENT` 同一时刻只能有一个请求在飞。**必须轮询调度。**
- 🔴 **Modbus 地址偏移搞错**（0-based vs 1-based，40001 vs 0）→ 读到相邻寄存器的值，**数据看起来"差不多但不对"**，极难发现。
  **→ 必须与设备手册逐项核对，并用已知值验证（比如读一个显示屏上能看到的数）。**
- 🔴 **字节序/字序搞错** → 32 位浮点或整数跨两个寄存器时，字序错了读出来是天文数字或极小值。**必须核对设备手册并实测。**
- 🔴 **通信断了继续用旧数据** → 同 6.1。**必须有「从站数据可信」标志并联锁。**
  典型事故场景：称重模块通信断了，重量值停在最后一次读到的值，程序以为料还在加。
- **`DONE` / `ERROR` 轮询** → 只置一个扫描周期，必须边沿捕获。
- **优化访问的 DB 用 `MB_DATA_PTR` 指针** → 【本机】
  EN: `Absolute access to data in blocks with optimized access is not permitted.`（`BL_PARSE_11A5`）/ ZH: `不允许在具有优化访问的块中对数据进行绝对寻址。`
  **→ Modbus 数据区 DB 通常需设为「标准访问」。** 这是 Modbus 最常撞的墙之一。
- **`STATUS` 不记录** → 出问题无从诊断。Modbus 的 STATUS 码信息量很大（区分超时、CRC 错、非法功能码、非法地址），**必须存并可查**。
- **RTU 接线不对**：A/B 极性、终端电阻（两端各 120Ω）、屏蔽接地、菊花链而非星形。**这些是硬件问题，程序查不出来**，表现为间歇性 CRC 错。
- **RTU 从站地址冲突** → 两个从站同地址，响应互相干扰。
- **不同品牌对 Modbus 标准的理解差异** → 有的设备"寄存器 0"是文档里的 40001，有的是 40000；有的对 32 位值用 CDAB 序。**永远以实测为准，不以文档为准。**
- **把 Modbus 数据用于安全联锁** → 通信有延迟、丢包。**安全功能绝不经通信。**
- **背景 DB 相关报错** 与 **优化/标准混用的拷贝传递** —— 同 6.1，此处不重复列。

### 上机前必须确认　⚠️【待老殷审】

- [ ] **RTU：`Modbus_Comm_Load` 已在首次扫描调用**，波特率/校验/停止位与从站手册一致
- [ ] **TCP：`CONNECT`（TCON_IP_v4）参数正确**，对端 IP/端口/连接 ID 已核对
- [ ] **一次只有一个请求在飞**，轮询调度已实现并实测（观察不会请求堆叠）
- [ ] **Modbus 寄存器地址已与设备手册逐项核对**，并用**已知值实测验证**（读一个仪表面板上能看到的数，核对一致）
- [ ] **字节序/字序已实测确认**（尤其 32 位浮点/整数）
- [ ] **「从站数据可信」标志已实现并联锁**（实测：拔通信线，确认程序不再用旧数据）
- [ ] `DONE` / `ERROR` 用边沿捕获
- [ ] Modbus 数据区 DB 的访问类型（标准/优化）与指针寻址匹配
- [ ] `STATUS` 已存并可在 HMI 查看，且已建立 STATUS 码 → 中文提示的映射
- [ ] **RTU 硬件已检查**：A/B 极性、两端终端电阻 120Ω、屏蔽单端接地、菊花链拓扑
- [ ] RTU 从站地址无冲突
- [ ] 通信超时 = 请求周期 × 3 且 ≥ 500 ms（RTU 视波特率加大），并实测触发
- [ ] 连续失败后的行为（报警/停机/降级）已与甲方确认
- [ ] **安全功能不经 Modbus**　【惯例，本项目强制】
- [ ] 长时间连续运行测试已做（≥ 24 h），记录通信失败率

### 可生成性
**🔴 暂不可自动生成 —— 等 TASK-012A 实证，当前只可人工编写。**
根因：`MB_CLIENT` / `MB_SERVER` / `Modbus_Comm_Load` / `Modbus_Master` / `Modbus_Slave` 全部是带背景 DB 的 FB 调用，`<Call>` 零实例。
✅ **可生成的部分（这部分其实是 Modbus 程序里最繁琐的一半）**：轮询调度器（`Add`/`Ge`/`Eq`/`Move`/`SCoil`/`RCoil`）、按序号装载功能码与地址长度参数（一串 `Eq` + `Move`）、结果边沿捕获、失败计数、超时、「从站数据可信」标志与联锁。
→ **向用户说明**：「轮询调度和参数表我生成好，你只需在博途里插入 Modbus 块并把引脚接到我建好的变量上」。这比什么都不给强得多。

---
