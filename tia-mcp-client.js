// TIA Portal MCP 客户端封装：把 TiaMcpServer.exe(vendor 在 engine/tia-mcp)当
// 常驻子进程跑，走 MCP stdio(newline-delimited JSON-RPC)调它的全部工具。
// 一次启动进程复用所有调用；子进程崩溃后下次调用自动重启。
// 零依赖，只用 Node 内置模块。
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const APP_ROOT = process.env.APP_ROOT || __dirname;
const DEFAULT_TIA_MAJOR_VERSION = 21;
const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'laoyin-plc-assistant', version: '1.0.0' };

function trimTrailingSeparators(value) {
    return String(value || '').trim().replace(/[\\/]+$/, '');
}

function existingDirectory(value, fsApi = fs) {
    const candidate = trimTrailingSeparators(value);
    try {
        return candidate && fsApi.existsSync(candidate) && fsApi.statSync(candidate).isDirectory() ? candidate : null;
    } catch {
        return null;
    }
}

function versionFromPath(value) {
    const match = String(value || '').match(/[\\/]Portal[ ]+V(\d+)(?:[\\/]|$)/i)
        || String(value || '').match(/[\\/]V(\d+)(?:[\\/]|$)/i);
    return match ? Number(match[1]) : null;
}

function registryValue(key, valueName = 'Path', exec = execFileSync) {
    try {
        const output = exec('reg', ['query', key, '/v', valueName], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        const line = String(output).split(/\r?\n/).find(row => new RegExp(`\\b${valueName}\\s+REG_\\w+\\s+`, 'i').test(row));
        if (!line) return null;
        const match = line.match(new RegExp(`\\b${valueName}\\s+REG_\\w+\\s+(.+)$`, 'i'));
        return match ? trimTrailingSeparators(match[1]) : null;
    } catch {
        return null;
    }
}

function portalRootFromAssemblyPath(assemblyPath, expectedMajorVersion) {
    const file = trimTrailingSeparators(assemblyPath);
    if (!file) return null;
    const root = file.replace(/[\\/]PublicAPI[\\/]V?\d+[\\/]net(?:4[578]|48)[\\/][^\\/]+\.dll$/i, '');
    if (root !== file && (expectedMajorVersion == null || versionFromPath(root) === Number(expectedMajorVersion))) {
        return existingDirectory(root);
    }
    return null;
}

/**
 * Finds a TIA Portal installation root without assuming the vendor's optional
 * _InstalledSW\\TIAP*\\TIA_Opns key exists. The Openness registry hive and
 * EditionMain are both valid Siemens installation sources.
 */
function findTiaPortalRoots(majorVersion = DEFAULT_TIA_MAJOR_VERSION, options = {}) {
    const roots = [];
    const add = (value, source) => {
        const root = existingDirectory(value, fsApi);
        if (!root) return;
        const foundVersion = versionFromPath(root);
        if (foundVersion != null && foundVersion !== Number(majorVersion)) return;
        if (!roots.some(item => item.path.toLowerCase() === root.toLowerCase())) roots.push({ path: root, source });
    };
    const env = options.env || process.env;
    const exec = options.execFileSync || execFileSync;
    const fsApi = options.fsApi || fs;
    const fileExists = options.existsSync || fsApi.existsSync;
    const defaultRoot = `C:\\Program Files\\Siemens\\Automation\\Portal V${majorVersion}`;

    add(env.YIN_TIA_PORTAL_ROOT, 'YIN_TIA_PORTAL_ROOT');
    add(env.TiaPortalLocation, 'TiaPortalLocation');

    const installed = `HKLM\\SOFTWARE\\Siemens\\Automation\\_InstalledSW\\TIAP${majorVersion}`;
    add(registryValue(`${installed}\\EditionMain`, 'Path', exec), 'registry:EditionMain');
    add(registryValue(`${installed}\\TIA_Opns`, 'Path', exec), 'registry:TIA_Opns');

    // Openness registry stores the authoritative assembly path even when the
    // optional TIA_Opns key is absent.
    let opennessAssembly = registryValue(
        `HKLM\\SOFTWARE\\Siemens\\Automation\\Openness\\${majorVersion}.0\\PublicAPI\\${majorVersion}.0.0.0\\net48`,
        'Siemens.Engineering.Base',
        exec
    );
    if (!opennessAssembly) {
        opennessAssembly = registryValue(
            `HKLM\\SOFTWARE\\Siemens\\Automation\\Openness\\${majorVersion}.0\\PublicAPI\\${majorVersion}.0.0.0\\net47`,
            'Siemens.Engineering.Base',
            exec
        );
    }
    add(portalRootFromAssemblyPath(opennessAssembly, majorVersion), 'registry:Openness/PublicAPI');

    const programFiles = env.ProgramW6432 || env.ProgramFiles || 'C:\\Program Files';
    const automationRoot = path.join(programFiles, 'Siemens', 'Automation');
    if (fileExists(automationRoot)) {
        try {
            for (const candidate of fsApi.readdirSync(automationRoot, { withFileTypes: true })) {
                if (!candidate.isDirectory() || !/^Portal V\d+$/i.test(candidate.name)) continue;
                add(path.join(automationRoot, candidate.name), 'filesystem:Program Files');
            }
        } catch { /* diagnostics will report missing path */ }
    }
    add(defaultRoot, 'default');
    return roots;
}

let cachedPortalRoots = new Map();
function detectPortalRoot(majorVersion = DEFAULT_TIA_MAJOR_VERSION, options = {}) {
    const cacheKey = String(majorVersion);
    if (!options.env && !options.execFileSync && !options.existsSync && !options.fsApi && cachedPortalRoots.has(cacheKey)) {
        return cachedPortalRoots.get(cacheKey);
    }
    const roots = findTiaPortalRoots(majorVersion, options);
    const chosen = roots.length ? roots[0].path : `C:\\Program Files\\Siemens\\Automation\\Portal V${majorVersion}`;
    if (!options.env && !options.execFileSync && !options.existsSync && !options.fsApi) cachedPortalRoots.set(cacheKey, chosen);
    return chosen;
}

class TiaMcpClient {
    constructor(options = {}) {
        this.tiaMajorVersion = Number(options.tiaMajorVersion || process.env.YIN_TIA_MAJOR_VERSION || DEFAULT_TIA_MAJOR_VERSION);
        this.exePath = options.exePath || process.env.YIN_TIA_MCP_EXE || path.join(APP_ROOT, 'engine', 'tia-mcp', 'runtime', `v${this.tiaMajorVersion}`, 'TiaMcpServer.exe');
        // Explicitly pass the detected install root. This bypasses machines where
        // Siemens did not create _InstalledSW\\TIAP*\\TIA_Opns.
        this.portalRoot = options.portalRoot || process.env.YIN_TIA_PORTAL_ROOT || (options.args ? null : detectPortalRoot(this.tiaMajorVersion));
        this.args = options.args || [
            '--tia-portal-location',
            options.portalRoot || process.env.YIN_TIA_PORTAL_ROOT || detectPortalRoot(this.tiaMajorVersion),
            '--tia-major-version',
            String(this.tiaMajorVersion)
        ];
        this.requestTimeoutMs = options.requestTimeoutMs || 120000; // TIA 冷启动很慢
        this.proc = null;
        this.nextId = 1;
        this.pending = new Map();      // id -> {resolve, reject, timer}
        this.lineBuffer = '';
        this.initialized = false;
        this.serverInfo = null;
        this.stderrLog = [];           // 最近 stderr 行，排障用
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
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id === undefined || msg.id === null) continue;
            const entry = this.pending.get(msg.id);
            if (!entry) continue;
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) entry.reject(new Error(`MCP ${msg.error.code}: ${msg.error.message}`));
            else entry.resolve(msg.result);
        }
    }

    _request(method, params, timeoutMs) {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP 请求超时(${method}, ${timeoutMs || this.requestTimeoutMs}ms)`));
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

    async ensureReady() {
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

    async callTool(name, args = {}, timeoutMs) {
        await this.ensureReady();
        const result = await this._request('tools/call', { name, arguments: args }, timeoutMs);
        if (result && result.isError) {
            const text = (result.content || []).map((c) => c.text || '').join('\n');
            throw new Error(`工具 ${name} 返回错误: ${text.slice(0, 500)}`);
        }
        return result;
    }

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
            portalRoot: this.portalRoot,
            tiaMajorVersion: this.tiaMajorVersion,
            running: this.isRunning(),
            initialized: this.initialized,
            serverInfo: this.serverInfo,
            pendingRequests: this.pending.size,
            recentStderr: this.stderrLog.slice(-10),
        };
    }
}

let shared = null;
function getSharedClient() {
    if (!shared) shared = new TiaMcpClient();
    return shared;
}

module.exports = { TiaMcpClient, getSharedClient, detectPortalRoot, findTiaPortalRoots, portalRootFromAssemblyPath };
