const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const APP_ROOT = process.env.APP_ROOT || __dirname;
const DEFAULT_ENGINE_ROOT = process.env.YIN_ROOT || path.join(APP_ROOT, 'engine');
const DEFAULT_WORKER = path.join(DEFAULT_ENGINE_ROOT, 'src', 'yin_worker.ps1');

function defaultIdleStopMs() {
    if (process.env.YIN_WORKER_IDLE_MS !== undefined) {
        const n = Number(process.env.YIN_WORKER_IDLE_MS);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    }
    return 0;
}

function commandExists(command) {
    if (!command) return false;
    if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
        return fs.existsSync(command);
    }
    return true;
}

class YinWorkerClient {
    constructor(options = {}) {
        this.exePath = options.exePath || process.env.YIN_POWERSHELL_EXE || 'powershell.exe';
        this.engineRoot = options.engineRoot || DEFAULT_ENGINE_ROOT;
        this.workerScript = options.workerScript || path.join(this.engineRoot, 'src', 'yin_worker.ps1');
        this.args = options.args || [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', this.workerScript,
            '-EngineRoot', this.engineRoot,
        ];
        this.usesDefaultArgs = !options.args;
        this.requestTimeoutMs = options.requestTimeoutMs || 300000;
        this.proc = null;
        this.nextId = 1;
        this.pending = new Map();
        this.lineBuffer = '';
        this.ready = false;
        this.project = '';
        this.tiaVersion = '';
        this.stderrLog = [];
        this.onStderr = options.onStderr || null;
        this.autoStopOnBeforeExit = options.autoStopOnBeforeExit !== false;
        this.beforeExitHandler = null;
        this.idleStopMs = options.idleStopMs === undefined ? defaultIdleStopMs() : options.idleStopMs;
        this.idleTimer = null;
    }

    available() {
        return commandExists(this.exePath) && (!this.usesDefaultArgs || fs.existsSync(this.workerScript));
    }

    isRunning() {
        return this.proc !== null && !this.proc.killed && this.proc.exitCode === null;
    }

    start() {
        if (this.isRunning()) return;
        if (!this.available()) {
            throw new Error(`Yin worker 不存在: ${this.exePath} ${this.usesDefaultArgs ? this.workerScript : ''}`.trim());
        }
        this._cancelIdleStop();
        this.lineBuffer = '';
        const proc = spawn(this.exePath, this.args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.proc = proc;
        proc.on('error', (err) => {
            if (this.proc !== proc) return;
            this._killAll(new Error('Yin worker 启动失败: ' + err.message));
            this.proc = null;
            this.ready = false;
        });
        proc.on('exit', (code, signal) => {
            if (this.proc !== proc) return;
            this._killAll(new Error(`Yin worker 子进程退出(code=${code} signal=${signal})`));
            this.proc = null;
            this.ready = false;
            this.project = '';
            this.tiaVersion = '';
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
        if (this.autoStopOnBeforeExit && !this.beforeExitHandler) {
            this.beforeExitHandler = () => this.stop();
            process.once('beforeExit', this.beforeExitHandler);
        }
    }

    stop() {
        this._cancelIdleStop();
        if (this.proc) {
            try { this.proc.kill(); } catch { /* already exited */ }
            this.proc = null;
        }
        this._killAll(new Error('Yin worker 客户端已停止'));
        this.ready = false;
        this.project = '';
        this.tiaVersion = '';
        if (this.beforeExitHandler) {
            process.removeListener('beforeExit', this.beforeExitHandler);
            this.beforeExitHandler = null;
        }
    }

    _cancelIdleStop() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    _scheduleIdleStop() {
        if (!this.idleStopMs || this.pending.size > 0 || !this.isRunning()) return;
        this._cancelIdleStop();
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            if (this.pending.size === 0) this.stop();
        }, this.idleStopMs);
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
                continue;
            }
            if (msg.id === undefined || msg.id === null) continue;
            const entry = this.pending.get(msg.id);
            if (!entry) continue;
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            entry.resolve(msg);
            this._scheduleIdleStop();
        }
    }

    _request(op, params = {}, timeoutMs) {
        return new Promise((resolve, reject) => {
            this._cancelIdleStop();
            if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) {
                reject(new Error('Yin worker 未运行'));
                return;
            }
            const id = this.nextId++;
            const effectiveTimeout = timeoutMs || this.requestTimeoutMs;
            const timer = setTimeout(() => {
                const err = new Error(`Yin worker 请求超时(${op}, ${effectiveTimeout}ms)`);
                this.ready = false;
                this._killAll(err);
                if (this.proc && this.proc.exitCode === null) {
                    try { this.proc.kill(); } catch { /* exit/error cleans up */ }
                }
            }, effectiveTimeout);
            this.pending.set(id, { resolve, reject, timer });
            const frame = JSON.stringify({ ...params, id, op }) + '\n';
            this.proc.stdin.write(frame, (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pending.delete(id);
                    reject(new Error('Yin worker 写入失败: ' + err.message));
                    this._scheduleIdleStop();
                }
            });
        });
    }

    async ensureReady() {
        if (this.proc && !this.isRunning() && this.proc.exitCode === null) {
            const exiting = this.proc;
            await new Promise((resolve) => exiting.once('exit', resolve));
        }
        this.start();
        if (this.ready) return;
        const result = await this._request('ping', {}, Math.min(this.requestTimeoutMs, 60000));
        if (!result || result.ok !== true || result.pong !== true) {
            throw new Error('Yin worker ping 失败');
        }
        this.project = result.project || '';
        this.tiaVersion = result.tiaVersion || '';
        this.ready = true;
    }

    async request(op, params = {}, timeoutMs) {
        await this.ensureReady();
        return this._request(op, params, timeoutMs);
    }

    status() {
        return {
            available: this.available(),
            exePath: this.exePath,
            workerScript: this.workerScript,
            running: this.isRunning(),
            ready: this.ready,
            project: this.project,
            tiaVersion: this.tiaVersion,
            pendingRequests: this.pending.size,
            recentStderr: this.stderrLog.slice(-10),
        };
    }
}

let shared = null;
function getSharedYinWorkerClient(options = {}) {
    if (!shared) shared = new YinWorkerClient(options);
    else if (Object.prototype.hasOwnProperty.call(options, 'idleStopMs')) shared.idleStopMs = options.idleStopMs;
    return shared;
}

module.exports = { YinWorkerClient, getSharedYinWorkerClient };
