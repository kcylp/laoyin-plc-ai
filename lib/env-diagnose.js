'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { sanitizeDiagnostic, sanitizeObject } = require('./sanitize');

const APP_ROOT = process.env.APP_ROOT || path.join(__dirname, '..');
const DOTNET48_MIN_RELEASE = 528040;

function resolvePowerShellPath(env = process.env) {
    const windowsRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
    const candidate = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return fs.existsSync(candidate) ? candidate : 'powershell.exe';
}

function parseJsonFromOutput(stdout) {
    const text = String(stdout || '').trim();
    if (!text) throw new Error('诊断脚本无输出');
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
        try { return JSON.parse(line); } catch { /* skip non-json noise */ }
    }
    throw new Error('诊断脚本输出不是 JSON: ' + text.slice(0, 200));
}

function defaultRunPowerShell(args, options = {}) {
    return new Promise((resolve) => {
        execFile(options.exePath || resolvePowerShellPath(), args, {
            cwd: options.appRoot || APP_ROOT,
            timeout: options.timeoutMs || 30000,
            maxBuffer: 20 * 1024 * 1024,
            windowsHide: true,
            encoding: 'utf8',
        }, (err, stdout, stderr) => {
            try {
                const output = parseJsonFromOutput(stdout);
                if (output && output.json && fs.existsSync(output.json)) {
                    const full = JSON.parse(fs.readFileSync(output.json, 'utf8'));
                    full.scriptOutput = output;
                    return resolve(full);
                }
                return resolve(output);
            } catch (parseErr) {
                return resolve({
                    scriptError: sanitizeDiagnostic([err && err.message, stderr, parseErr.message].filter(Boolean)).join('\n'),
                    issues: ['诊断脚本执行失败'],
                });
            }
        });
    });
}

function queryCount(db, sql) {
    try { return Number(db.prepare(sql).get().c) || 0; } catch { return 0; }
}

function fileExists(file) {
    try { return fs.existsSync(file); } catch { return false; }
}

function countSchemas(appRoot) {
    const dir = path.join(appRoot, 'engine', 'schemas');
    try { return fs.readdirSync(dir).filter(name => /\.xsd$/i.test(name)).length; } catch { return 0; }
}

function item(id, name, status, actual, expected, description, advice, autoFix = false, extra = {}) {
    return {
        id,
        名称: name,
        状态: status,
        status,
        实测值: actual == null ? '' : String(actual),
        期望值: expected == null ? '' : String(expected),
        中文说明: description,
        修复建议: advice,
        可自动修复: autoFix === true,
        ...extra,
    };
}

function statusText(status) {
    return ({ ok: '正常', warn: '需处理', fail: '失败', unknown: '待确认' })[status] || status;
}

function firstTiaInstall(raw) {
    const installs = Array.isArray(raw.tiaInstalls) ? raw.tiaInstalls : [];
    return installs[0] || null;
}

function buildItems(raw, options) {
    const appRoot = options.appRoot || APP_ROOT;
    const db = options.db;
    const env = options.env || process.env;
    const deep = options.deep === true;
    const modulePath = path.join(appRoot, 'engine', 'src', 'EngineerYin.psm1');
    const schemaCount = countSchemas(appRoot);
    const moduleFound = fileExists(modulePath);
    const providerCount = queryCount(db, 'SELECT COUNT(*) c FROM ai_providers');
    const modelCount = queryCount(db, 'SELECT COUNT(*) c FROM ai_models WHERE enabled=1');
    const aiReady = modelCount > 0;
    const mailConfigured = !!(env.SMTP_PASS || env.IMAP_PASS);
    const dotnet = raw.dotNetFramework || {
        Release: raw.dotNetFramework48Release || 0,
        Meets48: raw.dotNetFramework48Key === true,
    };
    const release = Number(dotnet.Release || 0);
    const install = firstTiaInstall(raw);
    const group = raw.opennessGroup || {};
    const port = raw.port3000 || {};
    const tiaProcess = raw.tiaProcess || {};
    const policy = raw.executionPolicy || {};
    const mcp = raw.mcp || {};
    const motw = raw.motw || {};
    const defender = raw.defender || {};
    const logPath = raw.logPathWritable || {};

    const items = [];
    items.push(item('node', 'Node.js', /^v(2[2-9]|[3-9]\d)\./.test(options.processVersion) ? 'ok' : 'fail', options.processVersion, 'Node.js 22.5+', '后端真实 process.version，不再读取浏览器 UA。', '请安装 Node.js 22.5 或更高版本。'));
    items.push(item('dotnet48', '.NET Framework 4.8', release >= DOTNET48_MIN_RELEASE || dotnet.Meets48 === true ? 'ok' : 'fail', release ? `Release ${release}` : '未检测到 Release DWORD', `Release >= ${DOTNET48_MIN_RELEASE}`, '.NET Framework 4.8 是 TIA MCP/Openness 通道的硬前提。', '安装 Microsoft .NET Framework 4.8 Runtime 或 Developer Pack 后重启。'));
    items.push(item('powershell-policy', 'PowerShell 执行策略', String(policy.Effective || '').toLowerCase() === 'restricted' ? 'warn' : 'ok', policy.Effective || '未读取到', '非 Restricted；诊断调用自带 Bypass', '诊断与写入脚本会显式使用 -ExecutionPolicy Bypass，避免策略假红。', '若仍被企业策略拦截，请联系 IT 放行本程序目录。'));
    items.push(item('tia-process', 'TIA Portal 进程/工程', tiaProcess.Running ? 'ok' : 'warn', tiaProcess.Running ? `${tiaProcess.ProcessCount || 1} 个进程，${tiaProcess.ProjectState || '工程状态未知'}` : '未运行', 'TIA Portal 已启动并打开工程', '连接博途前需要先启动 TIA Portal，并打开目标工程。', '先打开 TIA Portal 工程，再回到本页重新检查。'));
    items.push(item('port-3000', '端口 3000', port.InUse ? 'warn' : 'ok', port.InUse ? `已占用 PID: ${(port.Pids || []).join(',')}` : '未发现占用', '仅本程序占用或空闲', '端口冲突会导致绿色版服务启动失败或打开错实例。', '关闭占用 3000 端口的旧进程，或调整 PORT 后重启。'));
    items.push(item('engineer-yin', 'EngineerYin 引擎', moduleFound && schemaCount > 0 ? 'ok' : 'fail', moduleFound ? `${schemaCount} 个 XSD schema` : 'engine/src/EngineerYin.psm1 缺失', '引擎文件与 XSD schema 存在', '本地写入/预检依赖 EngineerYin PowerShell 引擎。', '恢复 engine 目录后重启服务。', false, { moduleFound, schemaCount }));
    items.push(item('openness-public-api', '博途 Openness PublicAPI', install && install.EngineeringBaseExists ? 'ok' : 'fail', install ? `TIA ${install.EngineeringVersion || install.RegistryVersion || '未知'} ${install.EngineeringBaseExists ? 'Base DLL 存在' : 'Base DLL 缺失'}` : '未检测到 Openness 注册信息', 'TIA Portal + Openness PublicAPI 已安装', '找不到 PublicAPI 时，只能做离线生成，不能连接已打开的博途工程。', '安装 TIA Portal 时勾选 Openness 组件；非默认路径场景请看深度诊断。', false, { tiaVersion: install && (install.EngineeringVersion || install.RegistryVersion || '') }));
    items.push(item('openness-group', 'Openness 用户组', group.Checked && group.InGroup ? 'ok' : 'warn', group.Checked ? (group.InGroup ? '当前用户已在 Siemens TIA Openness 组' : '当前用户不在 Siemens TIA Openness 组') : '无法确认组成员', '当前 Windows 用户在 Siemens TIA Openness 组', '没有组权限时，TIA 首次授权和 Attach 会失败。', '以管理员身份执行 net localgroup "Siemens TIA Openness" %USERNAME% /add，然后注销并重新登录。', group.Checked && !group.InGroup));
    items.push(item('ai-provider', 'AI 供应商', aiReady ? 'ok' : 'warn', aiReady ? `${providerCount} 个供应商，${modelCount} 个启用模型` : `${providerCount} 个供应商，0 个启用模型`, '至少 1 个启用模型', 'AI 生成能力需要可用供应商和启用模型。', '进入设置页填写 Base URL、API Key，并保存启用模型。', false, { providerCount, modelCount, aiReady }));
    items.push(item('mcp-runtime', '博途在线引擎运行时', mcp.ExeExists ? (deep ? (mcp.DoctorOk ? 'ok' : 'fail') : 'unknown') : 'fail', mcp.ExeExists ? (deep ? `doctor ${mcp.DoctorOk ? '通过' : '未通过'}` : '文件存在，尚未启动验证') : 'TiaMcpServer.exe 缺失', '运行时存在；深度诊断 doctor 通过', '文件存在不等于能启动；深度诊断会真实启动一次 MCP doctor。', '缺失时恢复 engine/tia-mcp/runtime；doctor 失败时查看诊断包中的 MCP 日志。', false, { doctorAttempted: !!mcp.DoctorAttempted, doctorMessage: sanitizeDiagnostic(mcp.DoctorMessage || '') }));
    items.push(item('mail', '邮件审批 SMTP/IMAP', mailConfigured ? 'ok' : 'warn', mailConfigured ? '已配置授权码' : '未配置 SMTP/IMAP 授权码', '需要邮件审批时配置授权码', '邮件审批不影响 PLC 主流程，但影响新用户邮件审批。', '需要邮件审批时，在启动器/配置中填写 SMTP_PASS 或 IMAP_PASS。', false, { mailConfigured }));

    if (deep) {
        const dllState = install ? ['EngineeringBase', 'Step7', 'WinCCUnified'].map(name => `${name}:${install[name + 'Exists'] ? 'ok' : 'missing'}`).join(', ') : '未检测到 TIA 安装';
        items.push(item('mcp-doctor', 'MCP doctor 实启动', mcp.DoctorOk ? 'ok' : 'fail', mcp.DoctorAttempted ? (mcp.DoctorOk ? '通过' : sanitizeDiagnostic(mcp.DoctorMessage || '未通过')) : '未执行', '30 秒内启动并返回通过', 'doctor 能一次覆盖 .NET、DLL、杀软拦截、版本不匹配等启动类问题。', '查看诊断包里的 TiaMcpServer.startup.log 和 诊断结果.json。'));
        items.push(item('tia-version-match', 'TIA/MCP 大版本匹配', install && mcp.ExeExists ? 'unknown' : 'warn', install ? `TIA ${install.EngineeringVersion || '未知'}；MCP 默认 V21` : '无 TIA 版本', 'TIA 大版本与 MCP runtime 大版本一致', '本项只做提示；请确认 TIA Portal 与在线引擎的大版本一致。', '若客户使用 V20/V19，请安装对应大版本的在线引擎后重试。'));
        items.push(item('allowlist', 'Openness 首次授权/AllowList', 'unknown', 'Node 侧无法无侵入读取', '首次连接时已允许本程序', 'TIA 的首次授权弹窗必须由用户确认。', '首次连接弹出授权框时选择允许；若被拒绝，清理 AllowList 后重试。'));
        items.push(item('key-dlls', '关键 Openness DLL', install && install.EngineeringBaseExists && install.Step7Exists ? (install.WinCCUnifiedExists ? 'ok' : 'warn') : 'fail', dllState, 'Base/Step7 存在；WinCCUnified 缺失时 HMI 能力降级', '缺 DLL 会导致 MCP 或 HMI/在线能力加载失败。', '修复 TIA Portal 安装或补齐对应选件。'));
        items.push(item('motw', '下载文件阻止标记 MOTW', Number(motw.BlockedCount || 0) > 0 ? 'warn' : 'ok', `${motw.BlockedCount || 0} 个 Zone.Identifier`, '程序目录没有下载阻止标记', '绿色包从网络下载后，MOTW 可能阻止 exe/dll 启动。', '右键 ZIP 先解除锁定再解压，或对程序目录执行 Unblock-File。'));
        items.push(item('defender', 'Defender/杀软拦截记录', String(defender.Status || '').toLowerCase() === 'detected' ? 'warn' : 'unknown', defender.Message || defender.Status || '无法读取或无记录', '无隔离/拦截记录', '读取安全日志可能需要权限，失败会降级为 unknown。', '若 MCP exe 被隔离，请在安全软件中恢复并加入信任目录。'));
        items.push(item('diagnostic-log', '诊断日志路径可写性', logPath.Writable ? 'ok' : 'fail', logPath.Checked ? (logPath.Writable ? '可写' : '不可写') : '未检查', 'work/diagnostics 与 MCP runtime 日志目录可写', '日志目录不可写时，启动失败会没有证据。', '把绿色包放到用户可写目录，不要直接放 Program Files。'));
    }

    return { items, aiReady, providerCount, modelCount, mailConfigured, moduleFound, schemaCount };
}

function summarize(items) {
    const counts = { ok: 0, warn: 0, fail: 0, unknown: 0 };
    for (const row of items) counts[row.状态] = (counts[row.状态] || 0) + 1;
    const main = items.find(row => row.状态 === 'fail') || items.find(row => row.状态 === 'warn') || items.find(row => row.状态 === 'unknown');
    const summary = `${counts.ok || 0} 项通过、${counts.warn || 0} 项警告、${counts.fail || 0} 项失败` + (main ? ` —— 主要关注：${main.名称}` : ' —— 可以开始使用');
    const healthScore = Math.max(0, Math.round(100 - (counts.fail || 0) * 18 - (counts.warn || 0) * 8 - (counts.unknown || 0) * 3));
    const issues = items.filter(row => row.状态 === 'fail' || row.状态 === 'warn').map(row => `${row.名称}: ${row.实测值}`);
    return { counts, summary, healthScore, issues };
}

async function runDiagnose({ deep = false, deps = {} } = {}) {
    const started = deps.now ? deps.now() : Date.now();
    const appRoot = deps.appRoot || APP_ROOT;
    const script = path.join(appRoot, 'tools', 'diagnose-tia.ps1');
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-AppRoot', appRoot];
    if (!deep) args.push('-SkipMcpDoctor');
    const raw = await (deps.runPowerShell || defaultRunPowerShell)(args, { appRoot, timeoutMs: deep ? 30000 : 10000 });
    const safeRaw = sanitizeObject(raw || {});
    const built = buildItems(safeRaw, {
        appRoot,
        db: deps.db,
        env: deps.env || process.env,
        deep,
        processVersion: deps.processVersion || process.version,
    });
    const summary = summarize(built.items);
    const finished = deps.now ? deps.now() : Date.now();
    return {
        success: true,
        deep,
        generatedAt: new Date(finished).toISOString(),
        durationMs: Math.max(0, finished - started),
        healthScore: summary.healthScore,
        summary: summary.summary,
        counts: summary.counts,
        issues: summary.issues,
        items: built.items,
        aiReady: built.aiReady,
        providerCount: built.providerCount,
        mailConfigured: built.mailConfigured,
        moduleFound: built.moduleFound,
        schemaCount: built.schemaCount,
        mcpAvailable: built.items.find(row => row.id === 'mcp-runtime')?.状态 !== 'fail',
        opennessPath: built.items.find(row => row.id === 'openness-public-api')?.状态 === 'ok',
        inOpennessGroup: built.items.find(row => row.id === 'openness-group')?.状态 === 'ok',
        diagnostic: safeRaw,
    };
}

function formatStamp(dateMs) {
    const d = new Date(dateMs);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function writeText(file, text) {
    fs.writeFileSync(file, sanitizeDiagnostic(text || ''), 'utf8');
}

function tailLines(file, maxLines) {
    try {
        return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-maxLines).join('\n');
    } catch {
        return '';
    }
}

function recentFiles(dir, pattern, limit) {
    try {
        return fs.readdirSync(dir)
            .filter(name => pattern.test(name))
            .map(name => path.join(dir, name))
            .map(file => ({ file, mtime: fs.statSync(file).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, limit)
            .map(entry => entry.file);
    } catch {
        return [];
    }
}

function safeCopyLog(src, dest, maxLines) {
    const text = tailLines(src, maxLines);
    if (text) writeText(dest, text);
}

function sha256File(file) {
    try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; }
}

function buildReport(result) {
    const lines = [
        '本诊断包已自动脱敏，不含账号密码与 API Key，可安全发送给技术支持。',
        '',
        '老殷工控 PLC 助手环境诊断报告',
        `生成时间: ${result.generatedAt}`,
        `总体健康分: ${result.healthScore}`,
        `结论: ${result.summary}`,
        '',
        '检查项:',
    ];
    for (const row of result.items) {
        lines.push(`- [${statusText(row.状态)}] ${row.名称}: ${row.实测值}`);
        if (row.修复建议) lines.push(`  建议: ${row.修复建议}`);
    }
    return lines.join('\n');
}

function buildSystemInfo(result) {
    const osInfo = result.diagnostic && result.diagnostic.os ? result.diagnostic.os : {};
    return [
        '系统信息',
        `Windows: ${osInfo.Caption || os.type()} ${osInfo.Version || os.release()} ${osInfo.Architecture || os.arch()}`,
        `Node.js: ${process.version}`,
        `PowerShell 执行策略: ${result.diagnostic?.executionPolicy?.Effective || 'unknown'}`,
        `DotNet Release: ${result.diagnostic?.dotNetFramework?.Release || 'unknown'}`,
        `TIA 安装: ${JSON.stringify(result.diagnostic?.tiaInstalls || [])}`,
    ].join('\n');
}

function buildVersionInfo(appRoot) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')); } catch { /* ignored */ }
    const runtimeDir = path.join(appRoot, 'engine', 'tia-mcp', 'runtime');
    const runtimeFiles = [];
    try {
        for (const version of fs.readdirSync(runtimeDir)) {
            const dir = path.join(runtimeDir, version);
            if (!fs.statSync(dir).isDirectory()) continue;
            for (const name of fs.readdirSync(dir).slice(0, 80)) runtimeFiles.push(path.join('runtime', version, name));
        }
    } catch { /* ignored */ }
    const mcpExe = path.join(appRoot, 'engine', 'tia-mcp', 'runtime', 'v21', 'TiaMcpServer.exe');
    return [
        '版本信息',
        `程序版本: ${pkg.version || 'unknown'}`,
        `程序名: ${pkg.name || 'unknown'}`,
        `TiaMcpServer.exe SHA256: ${sha256File(mcpExe) || 'not found'}`,
        'runtime 文件清单:',
        ...runtimeFiles,
    ].join('\n');
}

function copyDiagnosticLogs(appRoot, packageDir, localAppData) {
    const launchRoot = path.join(localAppData || process.env.LOCALAPPDATA || '', '老殷工控PLC助手');
    const launchDest = ensureDir(path.join(packageDir, '启动日志'));
    recentFiles(launchRoot, /^启动日志-.*\.txt$/i, 5).forEach((file, index) => {
        safeCopyLog(file, path.join(launchDest, `${String(index + 1).padStart(2, '0')}-${path.basename(file)}`), 200);
    });
    safeCopyLog(path.join(appRoot, 'work', 'logs', 'tia-ops.jsonl'), path.join(packageDir, 'tia-ops.jsonl'), 500);
    const startupLogs = [];
    for (const major of ['v21', 'v20']) {
        startupLogs.push(path.join(appRoot, 'engine', 'tia-mcp', 'runtime', major, 'TiaMcpServer.startup.log'));
    }
    const startupText = startupLogs.map(file => tailLines(file, 200)).filter(Boolean).join('\n');
    if (startupText) writeText(path.join(packageDir, 'TiaMcpServer.startup.log'), startupText);
}

async function exportDiagnosticPackage({ deep = false, deps = {} } = {}) {
    const now = deps.now ? deps.now() : Date.now();
    const appRoot = deps.appRoot || APP_ROOT;
    const desktop = ensureDir(deps.desktopDir || path.join(os.homedir(), 'Desktop'));
    const packageDir = ensureDir(path.join(desktop, `诊断包-${formatStamp(now)}`));
    const result = await runDiagnose({ deep, deps });
    const safeResult = sanitizeObject(result);
    writeText(path.join(packageDir, '诊断报告.txt'), buildReport(safeResult));
    fs.writeFileSync(path.join(packageDir, '诊断结果.json'), JSON.stringify(safeResult, null, 2), 'utf8');
    writeText(path.join(packageDir, '系统信息.txt'), buildSystemInfo(safeResult));
    writeText(path.join(packageDir, '版本信息.txt'), buildVersionInfo(appRoot));
    copyDiagnosticLogs(appRoot, packageDir, deps.localAppData);
    if (deps.openFolder !== false) {
        try { execFile('explorer.exe', [packageDir], { windowsHide: true }); } catch { /* customer can open returned path */ }
    }
    return {
        success: true,
        packagePath: packageDir,
        folder: packageDir,
        fileCount: fs.readdirSync(packageDir, { recursive: true }).length,
        sizeBytes: folderSize(packageDir),
        result: safeResult,
    };
}

function folderSize(dir) {
    let total = 0;
    try {
        for (const name of fs.readdirSync(dir, { recursive: true })) {
            const file = path.join(dir, name);
            const stat = fs.statSync(file);
            if (stat.isFile()) total += stat.size;
        }
    } catch { /* ignored */ }
    return total;
}

module.exports = { runDiagnose, exportDiagnosticPackage, buildItems, DOTNET48_MIN_RELEASE };
