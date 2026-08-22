# TIA Openness / MCP 故障排查

## 先分层判断

### A. 软件包层

- 绿色包是否完整解压到本地可写目录？
- `runtime\laoyin-server.exe`、`app\engine`、`app\engine\tia-mcp\runtime\v21\TiaMcpServer.exe` 是否都存在？
- 是否误用了旧绿色包？请记录包的 SHA256 和生成日期。
- 是否在压缩包内直接双击？必须先完整解压。

### B. TIA 安装层

- 控制面板中是否安装 TIA Portal V21？
- 安装选项中是否包含 Openness/PublicAPI？
- 是否存在 `Siemens.Engineering.Base.dll`？典型位置是 `C:\Program Files\Siemens\Automation\Portal V21\PublicAPI\V21\net48`。
- 若客户是 V20/V19/V18，当前 V21 MCP 运行包不能直接替代对应版本。

### C. Windows 权限层

- 当前用户是否在 `Siemens TIA Openness` 本地组？
- 加组后是否已经注销并重新登录？仅刷新窗口通常不会刷新令牌。
- 杀毒软件/应用控制是否阻止 `TiaMcpServer.exe`？不要关闭安全软件；请让管理员按哈希和路径加入允许名单。
- TIA Openness AllowList 是否需要由客户管理员登记新的 MCP 可执行文件？绿色包复制到另一台机器后，旧机器的 AllowList 路径不能自动适用于新路径。

### D. 工程状态层

- TIA Portal 是否已启动？
- 目标工程是否已打开且不是弹出模态对话框？
- 是否有另一个 Openness 客户端占用工程？先关闭无关自动化客户端。
- 连接只读检查通过后，再执行写入、编译、下载等高风险动作。

## 推荐证据

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\diagnose-tia.ps1
```

也可以从 MCP 运行目录执行只读医生命令（必须传真实安装根）：

```powershell
.\TiaMcpServer.exe --tia-portal-location "C:\Program Files\Siemens\Automation\Portal V21" --tia-major-version 21 tia doctor
```

不要把命令输出中的完整用户目录、数据库、`.env` 或日志文件发送给外部人员；诊断脚本已对路径和用户名做脱敏。

## 典型错误与处理

| 现象 | 根因方向 | 处理 |
|---|---|---|
| `Could not find TIA Portal installation path` | 安装路径注册表差异或未安装 | 用诊断脚本确认 Openness/PublicAPI；设置 `YIN_TIA_PORTAL_ROOT`；不要把 V21 路径指向 V20 |
| `Could not find DLL Siemens.Engineering...` | PublicAPI 缺失、版本不匹配或 MCP 运行时不完整 | 安装对应 Openness；保持 runtime DLL 同目录；确认大版本匹配 |
| 当前用户不在 Openness 组 | Windows 组未加入或令牌未刷新 | 管理员加组，注销/登录后重试 |
| 连接成功但没有工程 | TIA 未打开工程或工程路径不匹配 | 在 TIA 中打开目标工程，重新连接 |
| 启动器提示端口被占用 | 3000 被其他程序占用 | 关闭占用程序后重试；不要强杀不明系统进程 |
| 绿色包能启动但 TIA 失败 | 客户机环境或包不完整 | 先跑诊断脚本；完整提交 JSON/TXT，不要提交密钥/数据库 |

## 诊断报告安全

诊断报告只用于定位环境。不要修改报告来“伪造通过”；不要把 `plc_assistant.db`、`work\logs`、`.env`、授权文件或 `%LOCALAPPDATA%\老殷工控PLC助手` 一起打包。