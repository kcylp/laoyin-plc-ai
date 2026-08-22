// TIA Portal MCP 客户端封装：把 TiaMcpServer.exe(vendor 在 engine/tia-mcp)当
// 常驻子进程跑，走 MCP stdio(newline-delimited JSON-RPC)调它的全部 189 个工具。
// 一次启动进程复用所有调用;子进程崩溃后下次调用自动重启。
// 零依赖,只用 Node 内置模块。
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const APP_ROOT = process.env.APP_ROOT || __dirname;
const DEFAULT_EXE = path.join(APP_ROOT, 'engine', 'tia-mcp', 'runtime', 'v21', 'TiaMcpServer.exe');
const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'laoyin-plc-assistant', version: '1.0.0' };

// TiaMcpServer 的 resolver 读 HKLM\...\_InstalledSW\TIAP21\TIA_Opns\Path,而本机
// 西门子没注册这个子键(Openness 程序集走的是另一个注册表路径),必须显式传
// --tia-portal-location。安装根从 _InstalledSW\TIAP21\EditionMain 探测。
let cachedPortalRoot = null;
function detectPortalRoot() {
    if (cachedPortalRoot) return cachedPortalRoot;
    if (process.env.YIN_TIA_PORTAL_ROOT) {
        cachedPortalRoot = process.env.YIN_TIA_PORTAL_ROOT;
        return cachedPortalRoot;
    }
    try {
        const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Siemens\\Automation\\_InstalledSW\\TIAP21\\EditionMain', '/v', 'Path'], { encoding: 'utf8' });
        const m = out.match(/Path\s+REG_SZ\s+(.+)/);
        if (m) {
            cachedPortalRoot = m[1].trim().replace(/\\$/, '');
            return cachedPortalRoot;
        }
    } catch { /* 走默认 */ }
    cachedPortalRoot = 'C:\\Program Files\\Siemens\\Automation\\Portal V21';
    return cachedPortalRoot;
}

class TiaMcpClient {
    constructor(options = {}) {
        this.exePath = options.exePath || process.env.YIN_TIA_MCP_EXE || DEFAULT_EXE;
        // 显式传安装根,绕过本机缺失的 TIA_Opns 注册表子键
        this.args = options.args || ['--tia-portal-location', detectPortalRoot(), '--tia-major-version', '21'];
        this.requestTimeoutMs = options.requestTimeoutMs || 120000; // TIA 冷启动很慢
        this.proc = null;
        this.nextId = 1;
        this.pending = new Map();      // id -> {resolve, reject, timer}
        this.lineBuffer = '';
        this.initialized = false;
        this.serverInfo = null;
        this.stderrLog = [];           // 最近 stderr 行,排障用
        this.onStderr = options.onStderr || null;
    }

    available() {
        return fs.existsSync(this.exePath);
    }

    isRunning() {
        return this.proc !== null && !this.proc.killed && this.proc.exitCode === null;
    }

    start() {
        if (this.isRunning()) return;
        if (!this.available()) {
            throw new Error(`TiaMcpServer.exe 不存在: ${this.exePath}(engine/tia-mcp 未 vendor)`);
        }
        this.lineBuffer = '';
        const proc = spawn(this.exePath, this.args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.proc = proc;
        proc.on('error', (err) => {
            if (this.proc !== proc) return;
            this._killAll(new Error('MCP 子进程启动失败: ' + err.message));
            this.proc = null;
            this.initialized = false;
        });
        proc.on('exit', (code, signal) => {
            if (this.proc !== proc) return;
            this._killAll(new Error(`MCP 子进程退出(code=${code} signal=${signal})`));
            this.proc = null;
            this.initialized = false;
            this.lineBuffer = '';
        });
        proc.stdout.on('data', (chunk) => this._onStdout(chunk));
        proc.stderr.on('data', (chunk) => {
            const text = String(chunk);
            for (const line of text.split(/\r?\n/)) {
                if (!line.trim()) continue;
                this.stderrLog.push(line);
                if (this.stderrLog.length > 50) this.stderrLog.shift();
                if (this.onStderr) this.onStderr(line);
            }
        });
    }

    stop() {
        if (this.proc) {
            try { this.proc.kill(); } catch { /* 已退出 */ }
            this.proc = null;
        }
        this._killAll(new Error('MCP 客户端已停止'));
        this.initialized = false;
    }

    _killAll(err) {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(err);
        }
        this.pending.clear();
    }

    _onStdout(chunk) {
        this.lineBuffer += String(chunk);
        let idx;
        while ((idx = this.lineBuffer.indexOf('\n')) >= 0) {
            const line = this.lineBuffer.slice(0, idx).trim();
            this.lineBuffer = this.lineBuffer.slice(idx + 1);
            if (!line) continue;
            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                // exe 万一往 stdout 打了非 JSON 行,忽略不杀进程
                continue;
            }
            if (msg.id === undefined || msg.id === null) continue; // 通知,暂不需要
            const entry = this.pending.get(msg.id);
            if (!entry) continue;
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) {
                entry.reject(new Error(`MCP ${msg.error.code}: ${msg.error.message}`));
            } else {
                entry.resolve(msg.result);
            }
        }
    }

    _request(method, params, timeoutMs) {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP 请求超时(${method}, ${timeoutMs || this.requestTimeoutMs}ms)`));
                // 超时后服务端工具仍可能继续驱动 TIA。终止该进程，确保队列放行的
                // 下一项操作不会与已超时但仍在后台执行的旧操作并发。
                this.initialized = false;
                if (this.proc && this.proc.exitCode === null) {
                    try { this.proc.kill(); } catch { /* exit/error 事件负责清理 */ }
                }
            }, timeoutMs || this.requestTimeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
            this.proc.stdin.write(frame, (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pending.delete(id);
                    reject(new Error('MCP 写入失败: ' + err.message));
                }
            });
        });
    }

    _notify(method, params) {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }

    // 初始化握手(幂等):initialize → notifications/initialized
    async ensureReady() {
        // kill() 到 exit 之间旧进程尚未完全退出；必须等它退出后再拉新进程。
        if (this.proc && !this.isRunning() && this.proc.exitCode === null) {
            const exiting = this.proc;
            await new Promise((resolve) => exiting.once('exit', resolve));
        }
        this.start();
        if (this.initialized) return;
        const result = await this._request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: CLIENT_INFO,
        });
        this.serverInfo = result && result.serverInfo ? result.serverInfo : null;
        this._notify('notifications/initialized', {});
        this.initialized = true;
    }

    async listTools() {
        await this.ensureReady();
        const tools = [];
        let cursor;
        do {
            const page = await this._request('tools/list', cursor ? { cursor } : {});
            tools.push(...(page.tools || []));
            cursor = page.nextCursor;
        } while (cursor);
        return tools;
    }

    // 通用调用入口:189 个工具全部经此可达
    async callTool(name, args = {}, timeoutMs) {
        await this.ensureReady();
        const result = await this._request('tools/call', { name, arguments: args }, timeoutMs);
        // MCP tools/call 结果:{content:[{type:'text',text}], isError}
        if (result && result.isError) {
            const text = (result.content || []).map((c) => c.text || '').join('\n');
            throw new Error(`工具 ${name} 返回错误: ${text.slice(0, 500)}`);
        }
        return result;
    }

    // 从 tools/call 结果里提取文本内容(大多数 TIA 工具返回 JSON 文本)
    static textOf(result) {
        if (!result || !Array.isArray(result.content)) return '';
        return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    }

    static jsonOf(result) {
        const text = TiaMcpClient.textOf(result);
        try { return JSON.parse(text); } catch { return null; }
    }

    status() {
        return {
            available: this.available(),
            exePath: this.exePath,
            running: this.isRunning(),
            initialized: this.initialized,
            serverInfo: this.serverInfo,
            pendingRequests: this.pending.size,
            recentStderr: this.stderrLog.slice(-10),
        };
    }
}

// 全后端共享一个常驻客户端
let shared = null;
function getSharedClient() {
    if (!shared) shared = new TiaMcpClient();
    return shared;
}

module.exports = { TiaMcpClient, getSharedClient };
