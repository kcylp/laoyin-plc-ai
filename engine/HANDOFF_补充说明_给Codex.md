# 补充说明给 Codex（配合 HANDOFF_给Codex_遗留修复_20260803.md 阅读）

## A. 任务 A 的最优解法（星三角 TON 验证）

**不要自己去猜 TON/CoilReset 的 FlgNet 格式。** 正确路径：

```
1. 打开博途 V21，建一个临时 FB（随便叫 FB_TON_Test），放一个 TON 定时器 + 一个复位线圈
2. Connect-YinPortal
3. Export-YinBlockXml -BlockName "FB_TON_Test" -OutDir "$env:TEMP\ton_test"
4. 读导出的 XML → 里面就是 TON 和 CoilReset 的真实 FlgNet 表示
5. 把真实格式搬到 star_delta_fb.xml 里替换手猜的部分
6. 删除临时 FB_TON_Test（或保留当参考）
```

这个方法已经在起保停项目上验证过——每次遇到不知道的指令，就建临时块导出看真格式。
**不要直接往博途里导星三角 XML**——TON 格式没验证，大概率报错，先拿临时 FB 探路。

## B. 启动环境的前置步骤

```
1. 双击 F:\工控软件\老殷工控PLC助手\启动老殷工控PLC助手.bat  （网页平台 :3000）
2. 打开 TIA Portal V21 → 打开项目1 → 让博途保持在前台运行
3. PowerShell 里进 F:\工控软件\老殷工控PLC助手\engine\src
4. . .\YinResolver.ps1; Import-Module .\EngineerYin.psm1 -Force
5. Initialize-YinAssemblies
6. Connect-YinPortal  （需要在博途弹出的"允许连接"对话框点允许）
```

## C. 网页平台的调用链（如果改动涉及前端）

```
网页 UI (index.html/script.js)
  → POST /api/chat  → llm.js（AI 生成 XML）
  → POST /api/plc/import  → engineer-yin-bridge.js（调 PowerShell Import-YinBlock）
  → 编译结果回传 UI
```

- `engineer-yin-bridge.js` 是 bridge 层，调 PowerShell 脚本写博途
- `llm.js` 是 AI 层，负责从 AI 模型拿到生成的 XML
- `crypto-util.js` 是加密层，AES-256-GCM 加密存储 AI API Key
- 三件遗留任务主要改 `EngineerYin.Write.psm1`（引擎层），**不需要改网页层**

## D. 已知的坑（别踩）

| 坑 | 位置 | 后果 |
|---|---|---|
| PS5.1 GBK 读 UTF-8 无 BOM | 写任何 .ps1 文件 | 中文乱码→脚本解析崩溃，**纯 ASCII** |
| 广度反射 GetMethods | 对 V21 程序集 | 栈溢出杀进程 |
| PS ScriptBlock resolver | EngineerYin.psm1 旧版 | 爆栈，必须用 YinResolver.ps1 的 C# 版 |
| 旧桌面副本 | Desktop\5\plc-ai-assistant 和 Desktop\EngineerYin | 已废弃，不要读不要改 |
| HANDOFF_架构与接口路线.md 内路径 | 指向 Desktop\EngineerYin | 已过时，以本文档 §0（F 盘）为准 |

## E. 汇报格式

```
任务 X 完成：
- 文件:行号 → 改了什么
- 验证方式：Import + Compile 结果
- 编译诊断：0错0警 / 具体报错
- 用户已确认（如果写了博途）
```

禁止扔完整文件或完整 diff。一句话能说清的别写三句。
