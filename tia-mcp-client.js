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
    const root = file.replace(/[\\/]PublicAPI[\\/]V?\d+(?:\.\d+\.\d+\.\d+)?[\\/]net(?:4[578]|48)[\\/][^\\/]+\.dll$/i, '');
    if (root !== file && (expectedMajorVersion == null || versionFromPath(root) === Number(expectedMajorVersion))) {
        return existingDirectory(root);
    }
    return null;
}

function registryTiaMajorVersions(exec = execFileSync) {
    const majors = new Set();
    for (const [key, pattern] of [
        ['HKLM\\SOFTWARE\\Siemens\\Automation\\Openness', /\\(\d+)\.\d+\s*$/],
        ['HKLM\\SOFTWARE\\Siemens\\Automation\\_InstalledSW', /\\TIAP(\d+)\s*$/i],
    ]) {
        try {
            const output = exec('reg', ['query', key], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
            for (const line of String(output).split(/\r?\n/)) {
                const match = line.match(pattern);
                if (match) majors.add(Number(match[1]));
            }
        } catch { /* this registry source is optional */ }
    }
    return [...majors];
}

function publicApiDirFromAssemblyPath(assemblyPath, fsApi = fs) {
    const file = trimTrailingSeparators(assemblyPath);
    const directory = file ? path.dirname(file) : '';
    return existingDirectory(directory, fsApi);
}

/**
 * Finds a TIA Portal installation root without assuming the vendor's optional
 * _InstalledSW\\TIAP*\\TIA_Opns key exists. The Openness registry hive and
 * EditionMain are both valid Siemens installation sources.
 */
function findTiaPortalRoots(majorVersion = DEFAULT_TIA_MAJOR_VERSION, options = {}) {
    const roots = [];
    const env = options.env || process.env;
    const exec = options.execFileSync || execFileSync;
    const fsApi = options.fsApi || fs;
    const fileExists = options.existsSync || fsApi.existsSync;
    const add = (value, source, details = {}) => {
        const root = existingDirectory(value, fsApi);
        if (!root) return;
        const foundVersion = versionFromPath(root);
        if (foundVersion != null && foundVersion !== Number(majorVersion)) return;
        if (!roots.some(item => item.path.toLowerCase() === root.toLowerCase())) {
            roots.push({ path: root, source, ...details });
        }
    };

    add(env.YIN_TIA_PORTAL_ROOT, 'YIN_TIA_PORTAL_ROOT');
    add(env.TiaPortalLocation, 'TiaPortalLocation');

    const installed = `HKLM\\SOFTWARE\\Siemens\\Automation\\_InstalledSW\\TIAP${majorVersion}`;
    add(registryValue(`${installed}\\EditionMain`, 'Path', exec), 'registry:EditionMain');
    add(registryValue(`${installed}\\TIA_Opns`, 'Path', exec), 'registry:TIA_Opns');

    // Openness registry stores the authoritative assembly path even when the
    // optional TIA_Opns key is absent.
    const opennessBase = `HKLM\\SOFTWARE\\Siemens\\Automation\\Openness\\${majorVersion}.0\\PublicAPI\\${majorVersion}.0.0.0`;
    let opennessAssembly = null;
    for (const suffix of ['', '\\net48', '\\net47']) {
        for (const valueName of ['Siemens.Engineering.Base', 'Siemens.Engineering']) {
            opennessAssembly = registryValue(opennessBase + suffix, valueName, exec);
            if (opennessAssembly) break;
        }
        if (opennessAssembly) break;
    }
    add(portalRootFromAssemblyPath(opennessAssembly, majorVersion), 'registry:Openness/PublicAPI', {
        publicApiDir: publicApiDirFromAssemblyPath(opennessAssembly, fsApi),
    });

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
    return roots;
}

let cachedPortalRoots = new Map();
function detectPortalRoot(majorVersion = DEFAULT_TIA_MAJOR_VERSION, options = {}) {
    const cacheKey = String(majorVersion);
    if (!options.env && !options.execFileSync && !options.existsSync && !options.fsApi && cachedPortalRoots.has(cacheKey)) {
        return cachedPortalRoots.get(cacheKey);
    }
    const roots = findTiaPortalRoots(majorVersion, options);
    const chosen = roots.length ? roots[0].path : null;
    if (!options.env && !options.execFileSync && !options.existsSync && !options.fsApi) cachedPortalRoots.set(cacheKey, chosen);
    return chosen;
}

function getSupportedTiaMajorVersions(options = {}) {
    const fsApi = options.fsApi || fs;
    const runtimeDir = options.runtimeDir || path.join(APP_ROOT, 'engine', 'tia-mcp', 'runtime');
    try {
        return fsApi.readdirSync(runtimeDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && /^v\d+$/i.test(entry.name))
            .map(entry => Number(entry.name.slice(1)))
            .filter(Number.isInteger)
            .sort((a, b) => a - b);
    } catch {
        return [];
    }
}

function discoverTiaEnvironment(options = {}) {
    const env = options.env || process.env;
    const fsApi = options.fsApi || fs;
    const supportedByThisBuild = getSupportedTiaMajorVersions(options);
    const candidateMajors = new Set(supportedByThisBuild);
    const requestedMajor = Number(options.requestedMajor || env.YIN_TIA_MAJOR_VERSION || 0) || null;
    if (requestedMajor) candidateMajors.add(requestedMajor);
    for (const major of registryTiaMajorVersions(options.execFileSync || execFileSync)) candidateMajors.add(major);
    for (const explicitPath of [env.YIN_TIA_PORTAL_ROOT, env.TiaPortalLocation]) {
        const major = versionFromPath(explicitPath);
        if (major) candidateMajors.add(major);
    }
    const programFiles = env.ProgramW6432 || env.ProgramFiles || 'C:\\Program Files';
    const automationRoot = path.join(programFiles, 'Siemens', 'Automation');
    try {
        for (const entry of fsApi.readdirSync(automationRoot, { withFileTypes: true })) {
            const match = entry.isDirectory() && entry.name.match(/^Portal V(\d+)$/i);
            if (match) candidateMajors.add(Number(match[1]));
        }
    } catch { /* registry probing below may still find non-default installs */ }
    const installedVersions = [];
    for (const major of [...candidateMajors].sort((a, b) => a - b)) {
        const roots = findTiaPortalRoots(major, options);
        if (!roots.length) continue;
        const chosen = roots[0];
        const publicApiDir = chosen.publicApiDir || null;
        installedVersions.push({
            major,
            engineeringVersion: `V${major}`,
            portalRoot: chosen.path,
            publicApiDir,
            pathSource: chosen.source.startsWith('registry:') ? 'registry' : chosen.source,
            dllsPresent: {
                engineeringBase: publicApiDir ? fsApi.existsSync(path.join(publicApiDir, 'Siemens.Engineering.Base.dll')) : null,
                engineering: publicApiDir ? fsApi.existsSync(path.join(publicApiDir, 'Siemens.Engineering.dll')) : null,
            },
        });
    }

    const explicitMajor = versionFromPath(env.YIN_TIA_PORTAL_ROOT) || versionFromPath(env.TiaPortalLocation);
    const explicitInstalled = explicitMajor
        ? installedVersions.find(item => item.major === explicitMajor) || null
        : null;
    const requestedInstalled = requestedMajor
        ? installedVersions.find(item => item.major === requestedMajor) || null
        : null;
    const supportedInstalled = installedVersions.filter(item => supportedByThisBuild.includes(item.major));
    const selected = explicitInstalled || requestedInstalled || (supportedInstalled.length ? supportedInstalled : installedVersions).at(-1) || null;
    const mismatch = selected && !supportedByThisBuild.includes(selected.major)
        ? { detected: selected.major, supported: supportedByThisBuild.slice() }
        : false;
    let notice = '';
    if (installedVersions.length > 1 && selected) {
        const labels = installedVersions.map(item => `V${item.major}`).join('、');
        notice = `同时检测到博途 ${labels}，将使用 V${selected.major}。可设置 YIN_TIA_PORTAL_ROOT 指定其他安装路径。`;
    }
    return {
        installedVersions,
        selectedMajor: selected ? selected.major : null,
        supportedByThisBuild,
        mismatch,
        notice,
    };
}

class TiaMcpClient {
    constructor(options = {}) {
        this.runtimeDir = options.runtimeDir || path.join(APP_ROOT, 'engine', 'tia-mcp', 'runtime');
        this.customArgs = Array.isArray(options.args);
        const requestedMajor = Number(options.tiaMajorVersion || process.env.YIN_TIA_MAJOR_VERSION || 0) || null;
        const discoveryOptions = {
            ...(options.discoveryOptions || {}),
            runtimeDir: this.runtimeDir,
            requestedMajor,
        };
        if (options.portalRoot) {
            discoveryOptions.env = {
                ...(discoveryOptions.env || process.env),
                YIN_TIA_PORTAL_ROOT: options.portalRoot,
            };
        }
        this.discovery = this.customArgs ? null : discoverTiaEnvironment(discoveryOptions);
        const discoveredMajor = this.discovery && this.discovery.selectedMajor;
        const defaultSupportedMajor = this.discovery && this.discovery.supportedByThisBuild.at(-1);
        this.tiaMajorVersion = requestedMajor || discoveredMajor || defaultSupportedMajor || DEFAULT_TIA_MAJOR_VERSION;
        const selectedInstall = this.discovery && this.discovery.installedVersions
            .find(item => item.major === this.tiaMajorVersion);
        this.portalRoot = options.portalRoot || process.env.YIN_TIA_PORTAL_ROOT
            || (selectedInstall && selectedInstall.portalRoot) || null;
        this.explicitExePath = Boolean(options.exePath || process.env.YIN_TIA_MCP_EXE);
        this.exePath = options.exePath || process.env.YIN_TIA_MCP_EXE
            || path.join(this.runtimeDir, `v${this.tiaMajorVersion}`, 'TiaMcpServer.exe');
        this.args = options.args || [
            '--tia-portal-location',
            this.portalRoot,
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
        if (!this.customArgs) {
            if (this.discovery.mismatch) {
                const supported = this.discovery.mismatch.supported.map(version => `V${version}`).join('、') || '无';
                throw new Error(`检测到您安装的是博途 V${this.discovery.mismatch.detected}，而当前版本的助手仅支持博途 ${supported}。请联系我们获取对应版本。强行连接会导致程序崩溃，因此已阻止。`);
            }
            if ((!this.discovery.installedVersions.length || !this.portalRoot) && !this.explicitExePath) {
                throw new Error('未检测到博途安装。若已安装，可能是安装时未勾选 Openness 选件，或安装在非标准位置，请运行一键环境诊断。');
            }
            if (this.discovery.notice) {
                this.stderrLog.push(this.discovery.notice);
                if (this.onStderr) this.onStderr(this.discovery.notice);
            }
        }
        if (!this.available()) {
            throw new Error(`TiaMcpServer.exe 不存在: ${this.exePath}(engine/tia-mcp 未 vendor)`);
        }
        if (!this.customArgs && (!this.discovery.installedVersions.length || !this.portalRoot)) {
            throw new Error('未检测到博途安装。若已安装，可能是安装时未勾选 Openness 选件，或安装在非标准位置，请运行一键环境诊断。');
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
            discovery: this.discovery,
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

module.exports = {
    TiaMcpClient,
    getSharedClient,
    detectPortalRoot,
    discoverTiaEnvironment,
    findTiaPortalRoots,
    getSupportedTiaMajorVersions,
    portalRootFromAssemblyPath,
};
