// ============================================================
// 老殷工控PLC - EngineerYin 桥接模块
//   1) Test-YinFlgNet  -> 官方 XSD 校验（LAD/FBD、SCL、STL、Graph）
//   2) Initialize-YinOpenness -> 博途 Openness 环境自检
// 引擎路径探测顺序（任意机器都能跑）：
//   环境变量 YIN_ROOT > 本目录同级 engine/ > 上一级 EngineerYin引擎
// 引擎已经随网页平台一起拷贝成子目录，整个文件夹可整体搬走。
// ============================================================

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getSharedYinWorkerClient } = require('./yin-worker-client');

const PS1 = 'powershell.exe';

function resolveYinRoot() {
    if (process.env.YIN_ROOT) return process.env.YIN_ROOT;

    // 优先：网页平台自己带着的 engine/ 子目录（拷贝即用）
    const APP_ROOT = process.env.APP_ROOT || __dirname;
    const selfEngine = path.join(APP_ROOT, 'engine');
    if (fs.existsSync(path.join(selfEngine, 'src', 'EngineerYin.psm1'))) {
        return selfEngine;
    }

    // 回退：上一级目录的独立引擎
    const sibling = path.join(APP_ROOT, '..', 'EngineerYin引擎');
    if (fs.existsSync(path.join(sibling, 'src', 'EngineerYin.psm1'))) {
        return sibling;
    }

    throw new Error('EngineerYin 引擎未找到：请把 engine 目录放在本程序目录下，或用环境变量 YIN_ROOT 指定路径。');
}

const YIN_ROOT = resolveYinRoot();
const MODULE = path.join(YIN_ROOT, 'src', 'EngineerYin.psm1');

// 语言 -> EngineerYin schemas/ 下的官方 XSD 与其根元素
const LANG_SCHEMA = {
    lad: { schema: 'SW.PlcBlocks.LADFBD_v5.xsd', root: 'FlgNet', label: 'LAD/FBD 梯形图' },
    fbd: { schema: 'SW.PlcBlocks.LADFBD_v5.xsd', root: 'FlgNet', label: 'LAD/FBD 功能块图' },
    scl: { schema: 'SW.PlcBlocks.SCL_v4.xsd', root: 'StructuredText', label: 'SCL 结构化文本' },
    stl: { schema: 'SW.PlcBlocks.STL_v5.xsd', root: 'StatementList', label: 'STL 语句表' },
    graph: { schema: 'SW.PlcBlocks.Graph_v6.xsd', root: 'Graph', label: 'GRAPH 顺序控制' }
};

// 剥掉默认 xmlns 与命名空间前缀（官方 FlgNet/SCL XSD 均无 targetNamespace）
function stripNamespaces(xml) {
    return xml
        .replace(/\sxmlns(:[A-Za-z_][\w.-]*)?="[^"]*"/g, '')
        .replace(/<\/?[A-Za-z_][\w.-]*:/g, m => m.replace(/[A-Za-z_][\w.-]*:$/, ''))
        .replace(/\s[A-Za-z_][\w.-]*:([A-Za-z_][\w.-]*=)/g, ' $1');
}

// 导入语言归一化：引擎推断/前端传来的语言统一成小写键；
// 未知值一律回退 lad（校验路由的默认），不信任引擎输出。
function normalizeImportLanguage(lang) {
    const key = String(lang || '').toLowerCase();
    return LANG_SCHEMA[key] ? key : 'lad';
}

// 从 XML 自身 <ProgrammingLanguage> 标签探测语言（前端识别失败时的后端兜底）。
// 覆盖完整 <Document> 只有 ProgrammingLanguage、没有直接语言根节点的场景。
function detectLangFromXml(xmlContent) {
    const m = String(xmlContent || '').match(/<(?:[A-Za-z_][\w.-]*:)?ProgrammingLanguage(?:\s[^>]*)?>([^<]+)<\/(?:[A-Za-z_][\w.-]*:)?ProgrammingLanguage>/i);
    if (!m) return null;
    const key = m[1].trim().toLowerCase();
    return LANG_SCHEMA[key] ? key : null;
}

// 从任意输入中抽出所有待校验片段（支持完整 Document 多网络、带前缀、裸片段）
function extractFragments(xmlContent, root) {
    const clean = stripNamespaces(xmlContent);
    const re = new RegExp(`<${root}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${root}>`, 'g');
    const found = clean.match(re);
    if (found && found.length) return found;
    // 自闭合形式，例如 <StatementList />
    const selfClosing = clean.match(new RegExp(`<${root}(?:\\s[^>]*)?/>`, 'g'));
    if (selfClosing && selfClosing.length) return selfClosing;
    // 没找到根元素：把清洗后的整体交给校验器，让 XSD 给出准确报错
    return [clean];
}

// 调 PowerShell 跑 EngineerYin 的 Test-YinFlgNet
function runYinValidate(fragment, schemaFile) {
    return new Promise((resolve) => {
        const tmpFile = path.join(
            os.tmpdir(),
            `yin_${Date.now()}_${Math.random().toString(36).slice(2)}.xml`
        );
        try {
            fs.writeFileSync(tmpFile, fragment, 'utf8');
        } catch (e) {
            return resolve({ valid: false, errors: [{ line: 0, pos: 0, message: `临时文件写入失败: ${e.message}` }] });
        }

        const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
    Import-Module '${MODULE}' -Force
    $r = Test-YinFlgNet -XmlPath '${tmpFile}' -SchemaFile '${schemaFile}'
    [pscustomobject]@{
        Valid  = [bool]$r.Valid
        Errors = @($r.Errors | ForEach-Object { [pscustomobject]@{ Line=$_.Line; Pos=$_.Pos; Message=$_.Message } })
    } | ConvertTo-Json -Depth 5 -Compress
} catch {
    [pscustomobject]@{ Valid=$false; Errors=@([pscustomobject]@{ Line=0; Pos=0; Message=$_.Exception.Message }) } | ConvertTo-Json -Depth 5 -Compress
}`;

        execFile(PS1, ['-NoProfile', '-NonInteractive', '-Command', script], {
            timeout: 45000,
            maxBuffer: 20 * 1024 * 1024,
            windowsHide: true,
            encoding: 'utf8'
        }, (err, stdout) => {
            try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }

            const out = (stdout || '').trim();
            if (!out) {
                return resolve({
                    valid: false,
                    errors: [{ line: 0, pos: 0, message: `EngineerYin 调用失败: ${err ? err.message : '无输出'}` }]
                });
            }
            try {
                const parsed = JSON.parse(out);
                const raw = parsed.Errors == null ? [] : (Array.isArray(parsed.Errors) ? parsed.Errors : [parsed.Errors]);
                resolve({
                    valid: !!parsed.Valid,
                    errors: raw.map(e => ({
                        line: e.Line || 0,
                        pos: e.Pos || 0,
                        message: e.Message || '未知错误'
                    }))
                });
            } catch (e) {
                resolve({
                    valid: false,
                    errors: [{ line: 0, pos: 0, message: `解析校验结果失败: ${e.message}｜原始输出: ${out.slice(0, 200)}` }]
                });
            }
        });
    });
}

// 主入口：校验 AI 生成的 PLC XML（默认 LAD，可指定 scl/stl/graph/fbd）
async function validatePlcXml(xmlContent, lang = 'lad') {
    let key = String(lang || 'lad').toLowerCase();
    if (!LANG_SCHEMA[key]) {
        // 未知/缺失：先看文档自己声明了什么语言，再回退 LAD
        key = detectLangFromXml(xmlContent) || 'lad';
    }
    const cfg = LANG_SCHEMA[key];

    const fragments = extractFragments(xmlContent, cfg.root);
    const networks = [];

    for (let i = 0; i < fragments.length; i++) {
        const r = await runYinValidate(fragments[i], cfg.schema);
        networks.push({ index: i + 1, valid: r.valid, errors: r.errors });
    }

    const allErrors = [];
    networks.forEach(n => {
        n.errors.forEach(e => allErrors.push({ ...e, network: n.index }));
    });

    return {
        valid: networks.every(n => n.valid),
        lang: key,
        langLabel: cfg.label,
        schema: cfg.schema,
        networkCount: networks.length,
        networks,
        errors: allErrors
    };
}

function findAttribute(source, name) {
    const match = String(source || '').match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
    return match ? match[1] : '';
}

// AI 生成 LAD 并联/自锁时最常见的致命错误：给每条支路都写一条 <Powerrail />。
// 博途拒绝整块导入并报「在 LAD 中，程序段中只能包含一个电源线」。
// 实测（V21，块 LAD_ParallelProbe，编译 0 错）确认的正确表达：整个程序段只有
// 一条带 Powerrail 的 Wire，所有支路首触点的 in 都挂在这条 Wire 上；支路末端
// 通过 O 门（Part Name="O" + TemplateValue Card）的 in1/in2 汇合。
// 这里只做前者的自动修复——它是纯拓扑等价改写，安全；O 门属于逻辑结构，
// 必须由 AI 按提示词生成，不能在这里凭猜测插入。
function autoFixDuplicateWirePins(xmlContent) {
    const xml = String(xmlContent || '');
    const fixes = [];

    const fixed = xml.replace(/(<Wires\b[^>]*>)([\s\S]*?)(<\/Wires>)/gi, (whole, open, body, close) => {
        const wires = body.match(/<Wire\b[\s\S]*?<\/Wire>/gi);
        if (!wires || wires.length < 2) return whole;

        const railIndexes = [];
        wires.forEach((wireXml, index) => {
            if (/<Powerrail\b[^>]*\/?>/i.test(wireXml)) railIndexes.push(index);
        });
        if (railIndexes.length < 2) return whole;

        // 保留第一条电源线，把其余电源线上的端点搬进来后删除它们
        const keepIndex = railIndexes[0];
        const dropped = new Set();
        let keepWire = wires[keepIndex];

        for (const index of railIndexes.slice(1)) {
            const donors = [];
            for (const con of wires[index].matchAll(/<(?:NameCon|IdentCon)\b[^>]*?\/?>/gi)) {
                donors.push(con[0]);
            }
            if (donors.length) {
                keepWire = keepWire.replace(/<\/Wire>\s*$/i, donors.join('') + '</Wire>');
            }
            dropped.add(index);
        }

        fixes.push(`合并 ${railIndexes.length} 条电源线为 1 条（LAD 每个程序段只允许一条电源线）`);

        const rebuilt = wires
            .map((wireXml, index) => {
                if (dropped.has(index)) return null;
                return index === keepIndex ? keepWire : wireXml;
            })
            .filter(Boolean)
            .join('\n');

        return open + '\n' + rebuilt + '\n' + close;
    });

    return { xml: fixed, fixes, changed: fixes.length > 0 };
}

function validateLadBusinessRules(xmlContent) {
    const xml = String(xmlContent || '');
    const errors = [];
    const add = (network, rule, message, uid = '') => errors.push({ network, rule, message, uid });
    const language = detectLangFromXml(xml);
    if (language !== 'lad') {
        add(0, 'LAD_LANGUAGE', '块的 ProgrammingLanguage 必须为 LAD');
        return { valid: false, errors };
    }

    const networks = extractFragments(xml, 'FlgNet');
    if (!networks.length || !/<FlgNet[\s>]/i.test(xml)) {
        add(0, 'LAD_NETWORK', '缺少 NetworkSource/FlgNet');
        return { valid: false, errors };
    }

    networks.forEach((networkXml, index) => {
        const network = index + 1;
        const uids = new Set();
        const declared = new Set();
        for (const match of networkXml.matchAll(/<(Access|Part|Call|Wire|OpenCon)\b([^>]*)/gi)) {
            const uid = findAttribute(match[2], 'UId');
            if (!uid) continue;
            if (uids.has(uid)) add(network, 'UID_UNIQUE', `UId ${uid} 在同一网络重复`, uid);
            uids.add(uid);
            if (/^(Access|Part|Call)$/i.test(match[1])) declared.add(uid);
        }
        for (const match of networkXml.matchAll(/<(?:IdentCon|NameCon)\b([^>]*)/gi)) {
            const uid = findAttribute(match[1], 'UId');
            if (uid && !declared.has(uid)) add(network, 'WIRE_REFERENCE', `Wire 引用了不存在的 UId ${uid}`, uid);
        }

        // LAD 每个程序段只允许一条电源线（实测：博途报「在 LAD 中，程序段中
        // 只能包含一个电源线」并拒绝导入）。并联支路要共用同一条 Powerrail Wire。
        const railCount = (networkXml.match(/<Powerrail\b[^>]*\/?>/gi) || []).length;
        if (railCount > 1) {
            add(network, 'LAD_SINGLE_RAIL', `程序段有 ${railCount} 条电源线，LAD 只允许 1 条；并联支路应共用同一条电源线 Wire`);
        }

        // 并联 O 门必须声明输入路数，否则博途报 TemplateValue 'Card' missing
        for (const gate of networkXml.matchAll(/<Part\b([^>]*)\bName="(O|A|X)"([^>]*?)(?:\/>|>([\s\S]*?)<\/Part>)/gi)) {
            const uid = findAttribute(`${gate[1]} ${gate[3]}`, 'UId');
            const body = gate[4] || '';
            if (!/<TemplateValue\b[^>]*\bName="Card"[^>]*\bType="Cardinality"[^>]*>\d+<\/TemplateValue>/i.test(body)) {
                add(network, 'GATE_CARDINALITY', `${gate[2]} 门缺少 <TemplateValue Name="Card" Type="Cardinality">N</TemplateValue>`, uid);
            }
        }

        if (/<Part\b[^>]*\bName="(?:CoilSet|CoilReset)"/i.test(networkXml)) {
            add(network, 'COIL_INSTRUCTION', '禁止 CoilSet 或 CoilReset；请使用 SCoil 或 RCoil');
        }
        if (/<Part\b[^>]*\bName="TON"[\s\S]*?<\/Part>/i.test(networkXml) && /<Call\b[\s\S]*?<CallInfo\b[^>]*\bName="TON"/i.test(networkXml)) {
            add(network, 'TON_PART', 'TON 必须是 Part，不能是 Call');
        }

        for (const ton of networkXml.matchAll(/<Part\b([^>]*)\bName="TON"([^>]*)>([\s\S]*?)<\/Part>/gi)) {
            const attributes = `${ton[1]} ${ton[2]}`;
            const body = ton[3];
            const uid = findAttribute(attributes, 'UId');
            if (findAttribute(attributes, 'Version') !== '1.0') add(network, 'TON_VERSION', 'TON 必须带 Version="1.0"', uid);
            const instanceIndex = body.search(/<Instance\b/i);
            const templateIndex = body.search(/<TemplateValue\b[^>]*\bName="time_type"[^>]*\bType="Type"[^>]*>Time<\/TemplateValue>/i);
            if (instanceIndex < 0) add(network, 'TON_INSTANCE', 'TON 必须包含 Instance', uid);
            if (templateIndex < 0) add(network, 'TON_TEMPLATE', 'TON 必须包含 time_type=Time TemplateValue', uid);
            if (instanceIndex >= 0 && templateIndex >= 0 && instanceIndex > templateIndex) add(network, 'TON_ORDER', 'TON 的 Instance 必须位于 TemplateValue 前', uid);
            for (const pin of ['IN', 'PT', 'Q', 'ET']) {
                if (!new RegExp(`<NameCon\\b[^>]*\\bUId="${uid}"[^>]*\\bName="${pin}"`, 'i').test(networkXml)) {
                    add(network, 'TON_PIN', `TON 缺少 ${pin} 引脚连接`, uid);
                }
            }
            if (new RegExp(`<NameCon\\b[^>]*\\bUId="${uid}"[^>]*\\bName="(?:ENO|en|instance)"`, 'i').test(networkXml)) {
                add(network, 'TON_PIN', 'TON 禁止 ENO、en 或 instance 引脚', uid);
            }
            // Wire 是一组端点的集合，元素顺序不表达方向：<OpenCon/><NameCon ET/>
            // 与 <NameCon ET/><OpenCon/> 完全等价。按整条 Wire 判定，不能用
            // "ET 后面紧跟 OpenCon" 的顺序正则，否则合法写法会被误判失败。
            const etWireFound = [...networkXml.matchAll(/<Wire\b[^>]*>([\s\S]*?)<\/Wire>/gi)].some((w) => {
                const body = w[1];
                const hasEt = new RegExp(`<NameCon\\b[^>]*\\bUId="${uid}"[^>]*\\bName="ET"`, 'i').test(body);
                return hasEt && /<OpenCon\b/i.test(body);
            });
            if (!etWireFound) add(network, 'TON_ET_OPEN', 'TON 的 ET 必须连接 OpenCon', uid);
        }

        // 计数器（实测 V21）：缺 value_type 报 "The node 'TemplateValue' with the
        // name 'value_type' and the type 'type' is missing"；缺 Instance 同理拒导。
        // 泛型 IEC_COUNTER（InOut 参数）也走这个结构，Instance 指 InOut 成员即可。
        for (const ctr of networkXml.matchAll(/<Part\b([^>]*)\bName="(CTU|CTD|CTUD)"([^>]*)>([\s\S]*?)<\/Part>/gi)) {
            const uid = findAttribute(`${ctr[1]} ${ctr[3]}`, 'UId');
            const body = ctr[4];
            if (!/<Instance\b/i.test(body)) add(network, 'CTR_INSTANCE', `${ctr[2]} 必须包含 Instance`, uid);
            if (!/<TemplateValue\b[^>]*\bName="value_type"[^>]*\bType="Type"[^>]*>\w+<\/TemplateValue>/i.test(body)) {
                add(network, 'CTR_VALUE_TYPE', `${ctr[2]} 必须包含 <TemplateValue Name="value_type" Type="Type">Int</TemplateValue>（或其他数值类型）`, uid);
            }
        }

        for (const coil of networkXml.matchAll(/<Part\b([^>]*)\bName="(?:SCoil|RCoil)"([^>]*)\/?>(?:<\/Part>)?/gi)) {
            const uid = findAttribute(`${coil[1]} ${coil[2]}`, 'UId');
            for (const pin of ['in', 'operand']) {
                if (!new RegExp(`<NameCon\\b[^>]*\\bUId="${uid}"[^>]*\\bName="${pin}"`, 'i').test(networkXml)) {
                    add(network, 'SR_COIL_PIN', `${uid} 缺少小写 ${pin} 引脚连接`, uid);
                }
            }
        }
    });

    return { valid: errors.length === 0, errors };
}

// 兼容旧调用名
const validateFlgNetXml = (xml) => validatePlcXml(xml, 'lad');

// 博途 Openness 环境自检（走引擎的注册表版本探测，不写死 V21）
function checkOpennessEnvironment() {
    return new Promise((resolve) => {
        const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$result = [ordered]@{
    ModuleFound   = (Test-Path '${MODULE}')
    SchemaCount   = @(Get-ChildItem '${YIN_ROOT}\\schemas\\*.xsd' -ErrorAction SilentlyContinue).Count
    OpennessPath  = $false
    TiaVersion    = ''
    InGroup       = $false
    OpennessLoad  = $false
    Message       = ''
}
# version discovery from the engine (registry-based, any TIA version)
try {
    . (Join-Path '${YIN_ROOT}' 'src\\YinTiaDiscovery.ps1')
    $inst = Get-YinTiaInstall
    $result.OpennessPath = (Test-Path $inst.Net48Dir)
    $result.TiaVersion   = $inst.EngineeringVersion
} catch {
    $result.Message = $_.Exception.Message
}
try {
    $members = (net localgroup "Siemens TIA Openness") 2>$null
    $result.InGroup = [bool]($members -match [regex]::Escape($env:USERNAME))
} catch { }
if ($result.OpennessPath) {
    try {
        Import-Module '${MODULE}' -Force
        $null = Initialize-YinOpenness
        $result.OpennessLoad = $true
        $result.Message = "Openness 程序集加载成功，可连接博途 (TIA $($result.TiaVersion))"
    } catch {
        $result.Message = "Openness 加载失败: $($_.Exception.Message)"
    }
} else {
    $result.Message = '未检测到博途 Openness PublicAPI 目录，XSD 校验仍可用'
}
[pscustomobject]$result | ConvertTo-Json -Depth 3 -Compress`;

        execFile(PS1, ['-NoProfile', '-NonInteractive', '-Command', script], {
            timeout: 60000,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
            encoding: 'utf8'
        }, (err, stdout) => {
            const out = (stdout || '').trim();
            if (!out) {
                return resolve({
                    ok: false,
                    moduleFound: false,
                    message: `环境自检失败: ${err ? err.message : '无输出'}`
                });
            }
            try {
                const j = JSON.parse(out);
                resolve({
                    ok: !!j.ModuleFound && j.SchemaCount > 0,
                    moduleFound: !!j.ModuleFound,
                    schemaCount: j.SchemaCount || 0,
                    opennessPath: !!j.OpennessPath,
                    tiaVersion: j.TiaVersion || '',
                    inOpennessGroup: !!j.InGroup,
                    opennessLoaded: !!j.OpennessLoad,
                    message: j.Message || ''
                });
            } catch (e) {
                resolve({ ok: false, moduleFound: false, message: `解析自检结果失败: ${out.slice(0, 200)}` });
            }
        });
    });
}

function writeYinTempFile(xmlContent, kind) {
    const tmpFile = path.join(
        os.tmpdir(),
        `yin_web_${Date.now()}_${Math.random().toString(36).slice(2)}.${kind === 'xml' ? 'xml' : 'txt'}`
    );
    fs.writeFileSync(tmpFile, xmlContent, { encoding: 'utf8' });
    return tmpFile;
}

function runYinImportScriptLegacy(mode, tmpFile, overwrite, kind = 'xml') {
    return new Promise((resolve) => {
        const script = path.join(YIN_ROOT, 'src', 'yin_import.ps1');
        if (!fs.existsSync(script)) {
            return resolve({ ok: false, stage: 'error', message: `导入脚本缺失: ${script}` });
        }

        const args = [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', script,
            '-EngineRoot', YIN_ROOT,
            '-Mode', mode,
            '-XmlPath', tmpFile,
            '-Kind', kind
        ];
        if (overwrite) args.push('-Overwrite');

        execFile(PS1, args, {
            // 连博途 + 编译很慢，给足时间
            timeout: 300000,
            maxBuffer: 20 * 1024 * 1024,
            windowsHide: true,
            encoding: 'utf8'
        }, (err, stdout) => {
            // 脚本约定：stdout 最后一行是 JSON
            const lines = (stdout || '').trim().split('\n').map(s => s.trim()).filter(Boolean);
            const last = lines.length ? lines[lines.length - 1] : '';
            if (!last) {
                return resolve({
                    ok: false,
                    stage: 'error',
                    message: `引擎无输出${err ? ': ' + err.message : ''}`
                });
            }
            try {
                resolve(JSON.parse(last));
            } catch (e) {
                resolve({ ok: false, stage: 'error', message: `解析引擎输出失败: ${last.slice(0, 300)}` });
            }
        });
    });
}

function stopSharedEngineClients() {
    try { getSharedYinWorkerClient().stop(); } catch { /* ignore cleanup errors */ }
    try { require('./tia-mcp-client').getSharedClient().stop(); } catch { /* ignore cleanup errors */ }
}

// ---- 调 yin_import.ps1 / 常驻 yin_worker.ps1（preflight 只读 / import 写入）----
// PowerShell scripts are ASCII; localized content moves through UTF-8 temp files.
// kind: 'xml' = LAD/FBD 块级 XML 直接 Import；'scl'/'stl' = 源码走 ExternalSources
async function runYinImportScript(mode, xmlContent, overwrite, kind = 'xml', options = {}) {
    let tmpFile;
    try {
        tmpFile = writeYinTempFile(xmlContent, kind);
    } catch (e) {
        return { ok: false, stage: 'error', message: `临时文件写入失败: ${e.message}` };
    }

    const legacyRunner = options.legacyRunner || runYinImportScriptLegacy;
    const workerClient = options.workerClient || getSharedYinWorkerClient();
    try {
        if (String(process.env.YIN_WORKER || '1') !== '0') {
            try {
                return await workerClient.request(mode, { kind, path: tmpFile, overwrite: !!overwrite }, 300000);
            } catch (e) {
                console.error('[引擎] 常驻 worker 失败,回退一次性脚本:', e.message);
            }
        }
        return await legacyRunner(mode, tmpFile, overwrite, kind);
    } finally {
        try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
    }
}

// 博途 ExternalSources 的 SCL 解析器不支持双引号包裹的中文变量名：它会把中文
// 按 GBK 误读，报 Tag "鍚姩" not defined，且换任何文件编码都无法避免（UTF8 /
// UTF8-BOM / GBK 三种均实测失败）。不带引号的中文变量名反而能正常编译。
// AI 常按"全局变量写法"给接口区变量加引号，这里在写入前把这类引号剥掉。
// 只处理接口区声明与其在正文中的引用，不动字符串字面量与真正的全局符号引用。
function autoFixQuotedLocalNames(sourceText) {
    const text = String(sourceText || '');
    const fixes = [];

    // 收集接口区里被引号包裹的声明名
    const declared = new Set();
    const sectionRe = /(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_TEMP|VAR\b(?!_))([\s\S]*?)END_VAR/gi;
    for (const section of text.matchAll(sectionRe)) {
        for (const decl of section[2].matchAll(/(^|\n)([^\S\r\n]*)"([^"\r\n]+)"([^\S\r\n]*):/g)) {
            declared.add(decl[3]);
        }
    }
    if (!declared.size) return { text, fixes, changed: false };

    let out = text;

    // 1) 声明处去引号： "启动" : Bool;  ->  启动 : Bool;
    out = out.replace(sectionRe, (whole, kw, body) => {
        const cleaned = body.replace(/(^|\n)([^\S\r\n]*)"([^"\r\n]+)"([^\S\r\n]*):/g,
            (m, lead, indent, name, gap) => `${lead}${indent}${name}${gap}:`);
        return kw + cleaned + 'END_VAR';
    });

    // 2) 正文引用改成 # 前缀： "启动" -> #启动（只改声明过的名字）
    out = out.replace(/"([^"\r\n]+)"/g, (m, name) => (declared.has(name) ? '#' + name : m));

    // 3) 去掉重复前缀（原文已写 #"启动" 的情况）
    out = out.replace(/#\s*#/g, '#');

    if (out !== text) {
        fixes.push(`接口区变量去引号并改用 # 引用：${[...declared].join('、')}（博途源码解析器不支持带引号的中文变量名）`);
    }
    return { text: out, fixes, changed: out !== text };
}

// 判定一段文本该走哪条写入通道：
//   xml   - LAD/FBD 块级 XML，用 PlcBlockComposition.Import
//   scl   - SCL 源码，用 ExternalSources + GenerateBlocksFromSource
//   stl   - STL(AWL) 源码，同上
//   s7dcl - SIMATIC SD 文本（RUNG/Contact 文本 LAD），用在线引擎 ImportBlocksFromDocuments
// SCL 与 STL 的块级 XML 是 token 级格式（StructuredText / 枚举受限的 StlToken），
// 模型无法可靠生成，因此这两种语言一律走源码通道，由博途自己编译成块。
// s7dcl 必须最先判:它也含 FUNCTION_BLOCK 与 NETWORK,会被误判成 stl。
function detectPayloadKind(content) {
    const text = String(content || '');
    if (/S7_PreferredLanguage\s*:=\s*"LAD"|(?:^|\n)[^\S\r\n]*RUNG\s+wire#/i.test(text)) return 's7dcl';
    if (/^\s*<\?xml|^\s*<Document[\s>]/i.test(text)) return 'xml';

    // 源码以块声明开头（可能前面有注释行）
    if (/(?:^|\n)\s*(?:FUNCTION_BLOCK|FUNCTION|DATA_BLOCK|ORGANIZATION_BLOCK)\s+/i.test(text)) {
        // STL 正文用 NETWORK 分段 + 助记符；SCL 用赋值/控制结构
        if (/(?:^|\n)\s*NETWORK\b/i.test(text)) return 'stl';
        if (/:=|\bIF\b|\bCASE\b|\bFOR\b|\bWHILE\b|\bEND_IF\b/i.test(text)) return 'scl';
        return 'scl';
    }
    return 'xml';
}

// S7DCL 的「静默杀手」（实测 V21，探针存档）：网络标题必须是 .s7res 里注册过的
// MLC id——写字面量标题（如中文标题）导入时 0 块被收，且不报任何错。
// 这里把全部标题统一改写为 MLC_tN 并生成配套 .s7res（原文进 zh-CN），
// 让 AI 可以放心写字面量标题。
function autoFixS7DclTitles(content) {
    const text = String(content || '');
    const titles = [];
    const seen = new Map();
    for (const m of text.matchAll(/S7_NetworkTitle\s*:=\s*"([^"\r\n]*)"/gi)) {
        const t = m[1];
        if (!seen.has(t)) {
            seen.set(t, `MLC_t${seen.size + 1}`);
            titles.push({ text: t, id: seen.get(t) });
        }
    }
    if (!titles.length) return { text, res: '', fixes: [], changed: false };

    const out = text.replace(/(S7_NetworkTitle\s*:=\s*")([^"\r\n]*)(")/gi,
        (whole, pre, t, post) => pre + seen.get(t) + post);
    const yamlQuote = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    const res = 'MultiLingualTexts:\n' + titles.map(t => `  - id: ${t.id}\n    zh-CN: ${yamlQuote(t.text)}`).join('\n') + '\n';

    const needsFix = out !== text;
    const fixes = needsFix
        ? [`网络标题统一登记为 MLC id 并生成 .s7res(${titles.length} 个;字面量标题会导致导入静默跳过)`]
        : [];
    return { text: out, res, fixes, changed: needsFix };
}

// S7DCL 写入通道(在线引擎 / TiaMcpServer):
// 手写 .s7dcl + 自动生成的 .s7res → ImportBlocksFromDocuments → CompileAndDiagnosePlc
// 与 PowerShell 通道返回同形结果,上层(确认弹窗/结果展示)无感。
async function importS7DclDocument(content, overwrite) {
    const { getSharedClient, TiaMcpClient } = require('./tia-mcp-client');

    const fixed = autoFixS7DclTitles(content);
    const mDecl = /(?:^|\n)\s*(FUNCTION_BLOCK|FUNCTION|DATA_BLOCK|ORGANIZATION_BLOCK)\s+"?([A-Za-z_][\w]*)"?/i.exec(fixed.text);
    if (!mDecl) {
        return { ok: false, stage: 'precheck', kind: 's7dcl', message: 'S7DCL 缺少 FUNCTION_BLOCK / FUNCTION 等块声明' };
    }
    const blockName = mDecl[2];
    const blockType = { FUNCTION_BLOCK: 'FB', FUNCTION: 'FC', DATA_BLOCK: 'GlobalDB', ORGANIZATION_BLOCK: 'OB' }[mDecl[1].toUpperCase()] || 'unknown';

    const dir = path.join(os.tmpdir(), `yin_s7dcl_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    try {
        fs.mkdirSync(dir, { recursive: true });
        // .s7dcl / .s7res 都必须 UTF-8 带 BOM(实测:无 BOM 静默跳过)
        fs.writeFileSync(path.join(dir, `${blockName}.s7dcl`), '﻿' + fixed.text.replace(/^﻿/, ''), 'utf8');
        fs.writeFileSync(path.join(dir, `${blockName}.s7res`), '﻿' + fixed.res.replace(/^﻿/, ''), 'utf8');

        const client = getSharedClient();
        // 连同一个已打开的博途工程(与 PowerShell 通道同一实例)
        await client.callTool('Connect', {}, 300000);
        const proj = await client.callTool('GetProject', {}, 60000);
        const items = (TiaMcpClient.jsonOf(proj) || {}).items || [];
        const attr = (p, n) => { const a = (p.attributes || []).find(x => x.name === n); return a ? a.value : undefined; };
        const target = items.find(p => attr(p, 'IsPrimary') === true) || items[0];
        if (!target || !target.name) {
            return { ok: false, stage: 'connect', kind: 's7dcl', blockName, blockType, message: '博途里没有已打开的项目,请先在博途打开工程' };
        }
        await client.callTool('AttachToOpenProject', { projectName: target.name }, 60000);

        const imp = await client.callTool('ImportBlocksFromDocuments', {
            softwarePath: 'PLC_1',
            groupPath: '',
            importPath: dir,
            regexName: '^' + blockName + '$',
            importOption: overwrite ? 'Override' : 'None',
        }, 180000);
        const impJson = TiaMcpClient.jsonOf(imp) || {};
        const importedCount = (impJson.meta && typeof impJson.meta.importedBlocks === 'number')
            ? impJson.meta.importedBlocks
            : (impJson.items || []).length;
        if (!importedCount) {
            return {
                ok: false, stage: 'import', kind: 's7dcl', blockName, blockType,
                message: overwrite
                    ? `S7DCL 导入被跳过(0 块):检查格式(标题必须经 MLC 登记)/文件编码`
                    : `已存在同名块 ${blockName}(导入未选覆盖);如需替换请勾选覆盖`,
                messages: [TiaMcpClient.textOf(imp).slice(0, 300)],
            };
        }

        const cmp = await client.callTool('CompileAndDiagnosePlc', { softwarePath: 'PLC_1' }, 300000);
        const cmpJson = TiaMcpClient.jsonOf(cmp) || {};
        const lines = [...(cmpJson.info || []), ...(cmpJson.rawMessages || [])];
        const errLines = [...(cmpJson.errors || [])];
        const mine = lines.filter(l => l.includes(`Path=${blockName}`));
        const mineErr = errLines.filter(l => String(l).includes(`Path=${blockName}`));
        const totalErr = typeof cmpJson.errorCount === 'number' ? cmpJson.errorCount : errLines.length;
        const totalWarn = typeof cmpJson.warningCount === 'number' ? cmpJson.warningCount : (cmpJson.warnings || []).length;

        return {
            ok: mineErr.length === 0 && totalErr === 0,
            stage: 'done',
            kind: 's7dcl',
            project: target.name,
            imported: [blockName],
            blockName,
            blockType,
            language: 'LAD',
            compileState: cmpJson.state || '',
            errorCount: mineErr.length,
            warningCount: totalWarn,
            otherBlockErrors: totalErr - mineErr.length,
            messages: [...mine, ...errLines].slice(0, 30).map(String),
            autoFixes: fixed.changed ? fixed.fixes : undefined,
        };
    } catch (e) {
        return { ok: false, stage: 'error', kind: 's7dcl', blockName, blockType, message: `S7DCL 通道失败: ${e.message}` };
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败无碍 */ }
    }
}

// 写入前的自动修正：按通道分派。
//   xml  - 合并多余电源线（FlgNet 拓扑）
//   源码 - 剥掉接口区变量名的引号（博途 SCL 解析器限制）
function repairPayload(content, kind) {
    if (kind === 'xml') {
        const r = autoFixDuplicateWirePins(content);
        return { payload: r.xml, fixes: r.fixes, changed: r.changed };
    }
    const r = autoFixQuotedLocalNames(content);
    return { payload: r.text, fixes: r.fixes, changed: r.changed };
}

// 只读预检：连博途、报告将要发生什么（不写入）。
// lang 是用户在前端选的编程语言，只用于展示（覆盖引擎推断值）；
// runner 参数仅供测试注入，生产走默认 PowerShell 调用。
// s7dcl 通道的预检是本地解析(不连博途):重名与否由写入时的导入选项把关。
function preflightImport(xmlContent, lang, runner) {
    const kind = detectPayloadKind(xmlContent);
    if (kind === 's7dcl') {
        const mDecl = /(?:^|\n)\s*(FUNCTION_BLOCK|FUNCTION|DATA_BLOCK|ORGANIZATION_BLOCK)\s+"?([A-Za-z_][\w]*)"?/i.exec(xmlContent);
        const fixed = autoFixS7DclTitles(xmlContent);
        return Promise.resolve({
            ok: true,
            stage: 'precheck',
            kind: 's7dcl',
            project: '(在线引擎通道,写入时挂当前打开的工程)',
            plc: 'PLC_1',
            blockName: mDecl ? mDecl[2] : '(未识别)',
            blockType: mDecl ? ({ FUNCTION_BLOCK: 'FB', FUNCTION: 'FC', DATA_BLOCK: 'GlobalDB', ORGANIZATION_BLOCK: 'OB' }[mDecl[1].toUpperCase()] || 'unknown') : 'unknown',
            language: 'LAD(S7DCL)',
            nameTaken: false,
            autoFixes: fixed.changed ? fixed.fixes : undefined,
        }).then(r => { if (lang) r.language = normalizeImportLanguage(lang); return r; });
    }
    const run = runner || ((mode, xml, overwrite, k) => runYinImportScript(mode, xml, overwrite, k));
    const repaired = repairPayload(xmlContent, kind);
    return run('preflight', repaired.payload, false, kind).then((r) => {
        if (r && typeof r === 'object') {
            if (lang) r.language = normalizeImportLanguage(lang);
            if (repaired.changed) r.autoFixes = repaired.fixes;
        }
        return r;
    });
}

// 真正写入：自动修正 → XSD 校验（强制，仅 XML 通道）→ 导入 → 编译
function importToTia(xmlContent, overwrite) {
    const kind = detectPayloadKind(xmlContent);
    if (kind === 's7dcl') {
        return importS7DclDocument(xmlContent, overwrite);
    }
    const repaired = repairPayload(xmlContent, kind);
    return runYinImportScript('import', repaired.payload, !!overwrite, kind).then((r) => {
        if (r && typeof r === 'object' && repaired.changed) r.autoFixes = repaired.fixes;
        return r;
    });
}

module.exports = {
    validatePlcXml,
    validateLadBusinessRules,
    validateFlgNetXml,
    autoFixDuplicateWirePins,
    autoFixQuotedLocalNames,
    autoFixS7DclTitles,
    detectPayloadKind,
    normalizeImportLanguage,
    detectLangFromXml,
    checkOpennessEnvironment,
    stopSharedEngineClients,
    runYinImportScript,
    runYinImportScriptLegacy,
    preflightImport,
    importToTia,
    LANG_SCHEMA
};
