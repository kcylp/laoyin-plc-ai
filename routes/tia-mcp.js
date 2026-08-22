const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { logTiaOperation } = require('../lib/logger');
const { getSharedClient, TiaMcpClient } = require('../tia-mcp-client');

module.exports = function createTiaMcpRoutes(deps) {
    const { authenticateToken, localOnly, enqueueTiaOp, getUserById, getCurrentModel, listUserModels, llmStream, mcpEnsureAttached, parseBlocksFromTree, TIA_MCP_DANGEROUS, getPrewarmStatus } = deps;
    const router = express.Router();

router.get('/status', authenticateToken, localOnly, (req, res) => {
    const client = getSharedClient();
    res.json({ success: true, prewarm: getPrewarmStatus(), ...client.status() });
});

router.get('/tools', authenticateToken, localOnly, async (req, res) => {
    try {
        const client = getSharedClient();
        const tools = await client.listTools();
        res.json({
            success: true,
            count: tools.length,
            tools: tools.map(t => ({
                name: t.name,
                description: String(t.description || '').slice(0, 200),
                dangerous: TIA_MCP_DANGEROUS.test(t.name),
            })),
        });
    } catch (error) {
        console.error('MCP 工具清单错误:', error.message);
        res.status(500).json({ success: false, message: 'MCP 工具清单获取失败: ' + error.message });
    }
});

// 连接博途并挂到当前打开的项目(与写入通道同一个实例,防冲突第 2 条)
router.post('/connect', authenticateToken, localOnly, async (req, res) => {
    const user = getUserById(req.user.id);
    console.log(`[MCP] 连接博途 用户=${user ? user.username : req.user.id}`);
    try {
        const client = getSharedClient();
        const out = await enqueueTiaOp(async () => {
            const att = await mcpEnsureAttached(client);
            const state = await client.callTool('GetState', {}, 30000).catch(() => null);
            return {
                connected: att.ok,
                attached: att.ok ? `已挂接工程「${att.project}」` : att.note,
                state: state && (TiaMcpClient.jsonOf(state) || TiaMcpClient.textOf(state).slice(0, 300)),
            };
        });
        res.json({ success: true, ...out });
    } catch (error) {
        console.error('MCP 连接错误:', error.message);
        res.status(500).json({ success: false, message: 'MCP 连接失败: ' + error.message });
    }
});

router.get('/software-tree', authenticateToken, localOnly, async (req, res) => {
    try {
        const client = getSharedClient();
        const out = await enqueueTiaOp(async () => {
            const att = await mcpEnsureAttached(client);
            if (!att.ok) return { connected: false, note: att.note };
            const r = await client.callTool('GetSoftwareTree', { softwarePath: 'PLC_1' }, 60000);
            const tree = (TiaMcpClient.jsonOf(r) || {}).tree || '';
            return { connected: true, project: att.project, tree, blocks: parseBlocksFromTree(tree) };
        });
        res.json({ success: true, ...out });
    } catch (error) {
        console.error('MCP 软件树错误:', error.message);
        res.status(500).json({ success: false, message: '软件树获取失败: ' + error.message });
    }
});

// 解读程序:把博途里的块读成可读逻辑(DescribeBlockLogic)
// LAD 梯形图还原成布尔表达式,SCL/STL 读取其逻辑文本——电工看懂现场程序用。
router.post('/describe-block', authenticateToken, localOnly, async (req, res) => {
    const blockPath = String(req.body.blockPath || '').trim();
    const name = String(req.body.name || '').trim();
    if (!blockPath && !name) {
        return res.status(400).json({ success: false, message: '缺少 blockPath 或 name' });
    }
    const target = blockPath || ('Program blocks/' + name);
    const user = getUserById(req.user.id);
    console.log(`[MCP] 解读程序 ${target} 用户=${user ? user.username : req.user.id}`);
    try {
        const client = getSharedClient();
        const out = await enqueueTiaOp(async () => {
            const att = await mcpEnsureAttached(client);
            if (!att.ok) return { connected: false, note: att.note };
            const r = await client.callTool('DescribeBlockLogic', { softwarePath: 'PLC_1', blockPath: target }, 60000);
            const j = TiaMcpClient.jsonOf(r) || {};
            return {
                connected: true,
                project: att.project,
                blockName: name || blockPath,
                language: j.language || '',
                readable: j.readable || TiaMcpClient.textOf(r),
            };
        });
        res.json({ success: true, ...out });
    } catch (error) {
        console.error('MCP 解读程序错误:', error.message);
        res.status(500).json({ success: false, message: '解读程序失败: ' + error.message });
    }
});

// 通用工具调用:201 个工具全量可达(能力全面合并的入口)
router.post('/call', authenticateToken, localOnly, async (req, res) => {
    const name = String(req.body.name || '');
    const args = req.body.args && typeof req.body.args === 'object' ? req.body.args : {};
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
        return res.status(400).json({ success: false, message: '工具名不合法' });
    }
    const dangerous = TIA_MCP_DANGEROUS.test(name);
    if (dangerous && req.body.confirmed !== true) {
        return res.status(400).json({ success: false, message: `工具 ${name} 属危险操作(下载/删除类),需要 confirmed:true`, dangerous: true });
    }
    const user = getUserById(req.user.id);
    console.log(`[MCP] 调用 ${name} 用户=${user ? user.username : req.user.id} 危险=${dangerous} 参数=${JSON.stringify(args).slice(0, 300)}`);
    const startedAt = Date.now();
    try {
        const client = getSharedClient();
        const timeoutMs = Math.min(Math.max(Number(req.body.timeoutMs) || 120000, 5000), 600000);
        const result = await enqueueTiaOp(() => client.callTool(name, args, timeoutMs));
        logTiaOperation({
            user,
            op: 'mcp:' + name,
            target: args.softwarePath || args.blockPath || args.projectName || name,
            ms: Date.now() - startedAt,
            ok: true,
            err: null,
        });
        res.json({ success: true, tool: name, dangerous, json: TiaMcpClient.jsonOf(result), text: TiaMcpClient.textOf(result).slice(0, 20000) });
    } catch (error) {
        logTiaOperation({ user, op: 'mcp:' + name, target: args.softwarePath || args.blockPath || args.projectName || name, ms: Date.now() - startedAt, ok: false, err: error });
        console.error(`MCP 调用 ${name} 错误:`, error.message);
        res.status(500).json({ success: false, tool: name, message: `MCP 调用 ${name} 失败: ` + error.message });
    }
});

// ---------- 一键建工程:自然语言 → 我们自己的模型产 spec → ScaffoldProject ----------
// 「AI 融合为一个模型」的落点:spec 生成走本系统已配置的模型(与聊天同源),
// 不需要用户去外面找别的 AI。先 dryRun 离线校验;confirmed:true 才真正建工程。
function normalizeHardwareItems(payload) {
    const raw = Array.isArray(payload) ? payload
        : (payload && (payload.Items || payload.items || payload.Results || payload.results)) || [];
    return (Array.isArray(raw) ? raw : []).map((item) => ({
        articleNumber: item.ArticleNumber || item.articleNumber || '',
        catalogPath: item.CatalogPath || item.catalogPath || '',
        description: item.Description || item.description || '',
        typeIdentifier: item.TypeIdentifier || item.typeIdentifier || '',
        typeIdentifierNormalized: item.TypeIdentifierNormalized || item.typeIdentifierNormalized || '',
        typeName: item.TypeName || item.typeName || '',
        version: item.Version || item.version || '',
        insertable: item.Insertable !== undefined ? item.Insertable : item.insertable,
        score: item.Score !== undefined ? item.Score : item.score,
    }));
}

function normalizeTagTables(payload) {
    const raw = Array.isArray(payload) ? payload
        : (payload && (payload.Items || payload.items || payload.Tables || payload.tables)) || [];
    return Array.isArray(raw) ? raw : [];
}

function findFilesRecursive(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...findFilesRecursive(fullPath));
        else files.push(fullPath);
    }
    return files;
}

function escapeRegexLiteral(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

router.post('/search-hardware', authenticateToken, localOnly, async (req, res) => {
    const keyword = String(req.body.keyword || '').trim();
    const limit = Math.min(Math.max(Number(req.body.limit) || 50, 1), 50);
    if (!keyword) return res.status(400).json({ success: false, message: '缺少硬件搜索关键字' });
    const user = getUserById(req.user.id);
    const startedAt = Date.now();
    try {
        const client = getSharedClient();
        const result = await enqueueTiaOp(async () => {
            const attached = await mcpEnsureAttached(client);
            if (!attached.ok) {
                const error = new Error(attached.note || '未挂接 TIA 工程');
                error.statusCode = 409;
                throw error;
            }
            return client.callTool('SearchHardwareCatalog', { keyword, limit });
        });
        const json = TiaMcpClient.jsonOf(result) || {};
        const items = normalizeHardwareItems(json).slice(0, limit);
        logTiaOperation({ user, op: 'mcp:SearchHardwareCatalog', target: keyword, ms: Date.now() - startedAt, ok: true, err: null });
        res.json({ success: true, keyword, limit, count: items.length, items });
    } catch (error) {
        logTiaOperation({ user, op: 'mcp:SearchHardwareCatalog', target: keyword, ms: Date.now() - startedAt, ok: false, err: error });
        res.status(error.statusCode || 500).json({ success: false, connected: false, message: '硬件目录搜索失败: ' + error.message });
    }
});

router.post('/tag-tables', authenticateToken, localOnly, async (req, res) => {
    const softwarePath = String(req.body.softwarePath || 'PLC_1').trim() || 'PLC_1';
    const user = getUserById(req.user.id);
    const startedAt = Date.now();
    try {
        const client = getSharedClient();
        const out = await enqueueTiaOp(async () => {
            const attached = await mcpEnsureAttached(client);
            if (!attached.ok) {
                const error = new Error(attached.note || '未挂接 TIA 工程');
                error.statusCode = 409;
                throw error;
            }
            const result = await client.callTool('GetPlcTagTables', { softwarePath });
            const json = TiaMcpClient.jsonOf(result);
            return { connected: true, project: attached.project, tables: normalizeTagTables(json), json, text: TiaMcpClient.textOf(result).slice(0, 20000) };
        });
        logTiaOperation({ user, op: 'mcp:GetPlcTagTables', target: softwarePath, ms: Date.now() - startedAt, ok: true, err: null });
        res.json({ success: true, softwarePath, ...out });
    } catch (error) {
        logTiaOperation({ user, op: 'mcp:GetPlcTagTables', target: softwarePath, ms: Date.now() - startedAt, ok: false, err: error });
        res.status(error.statusCode || 500).json({ success: false, connected: false, message: '变量表读取失败: ' + error.message });
    }
});

router.post('/export-s7dcl', authenticateToken, localOnly, async (req, res) => {
    const softwarePath = String(req.body.softwarePath || 'PLC_1').trim() || 'PLC_1';
    const blockPath = String(req.body.blockPath || '').trim();
    const name = String(req.body.name || '').trim();
    const targetName = name || path.basename(blockPath.replace(/\\/g, '/'));
    if (!blockPath) return res.status(400).json({ success: false, message: '缺少要导出的程序块路径' });
    if (!targetName) return res.status(400).json({ success: false, message: '缺少要导出的程序块名称' });
    const regexName = '^' + escapeRegexLiteral(targetName) + '$';
    const user = getUserById(req.user.id);
    const startedAt = Date.now();
    let exportDir = '';
    try {
        exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-s7dcl-'));
        const client = getSharedClient();
        const result = await enqueueTiaOp(async () => {
            const attached = await mcpEnsureAttached(client);
            if (!attached.ok) throw new Error(attached.note || '未挂接 TIA 工程');
            const treeResult = await client.callTool('GetSoftwareTree', { softwarePath }, 60000);
            const tree = (TiaMcpClient.jsonOf(treeResult) || {}).tree || '';
            const sameName = parseBlocksFromTree(tree).filter((block) => block.name.toLowerCase() === targetName.toLowerCase());
            const normalizedPath = blockPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
            const selected = sameName.find((block) => block.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase() === normalizedPath);
            if (!selected) {
                const error = new Error(`软件树中找不到程序块路径: ${blockPath}`);
                error.statusCode = 404;
                throw error;
            }
            if (sameName.length > 1) {
                const error = new Error(`检测到 ${sameName.length} 个同名块“${targetName}”，批量导出工具无法按组路径唯一定位，已拒绝导出以避免下载错误内容`);
                error.statusCode = 409;
                throw error;
            }
            return client.callTool('ExportBlocksAsDocuments', {
                softwarePath,
                exportPath: exportDir,
                regexName,
                preservePath: false,
            }, 180000);
        });
        const files = findFilesRecursive(exportDir).filter((filePath) => /\.s7dcl$/i.test(filePath));
        const preferred = files.find((filePath) => name && path.basename(filePath, path.extname(filePath)).toLowerCase() === name.toLowerCase()) || files[0];
        if (!preferred) {
            const detail = TiaMcpClient.jsonOf(result) || TiaMcpClient.textOf(result);
            throw new Error('MCP 未生成 .s7dcl 文件: ' + JSON.stringify(detail).slice(0, 500));
        }
        const content = fs.readFileSync(preferred, 'utf8');
        const filename = path.basename(preferred).toLowerCase().endsWith('.s7dcl') ? path.basename(preferred) : ((name || 'blocks') + '.s7dcl');
        logTiaOperation({ user, op: 'mcp:ExportBlocksAsDocuments', target: blockPath || name || softwarePath, ms: Date.now() - startedAt, ok: true, err: null });
        res.json({ success: true, softwarePath, blockPath, filename, content });
    } catch (error) {
        logTiaOperation({ user, op: 'mcp:ExportBlocksAsDocuments', target: blockPath || name || softwarePath, ms: Date.now() - startedAt, ok: false, err: error });
        res.status(error.statusCode || 500).json({ success: false, message: 'S7DCL 导出失败: ' + error.message });
    } finally {
        if (exportDir) {
            try { fs.rmSync(exportDir, { recursive: true, force: true }); } catch { /* 临时目录由系统后续清理 */ }
        }
    }
});
async function chatOnce({ modelId, userId, messages }) {
    let text = '';
    await llmStream({
        modelId,
        userId,
        messages,
        onDelta: (delta) => { text += delta; },
    });
    return text;
}

const SCAFFOLD_SPEC_PROMPT = `你是西门子 TIA Portal 工程生成助手。用户用自然语言描述一个 PLC/HMI 工程,你只输出一份严格合法的 JSON(不输出任何解释文字,不要 Markdown 代码围栏)。
规则:
1. 只用这些键:projectName(必填)、directoryPath、plcName、plcFamily(S7-1500 或 S7-1200)、plcMlfb、hmiName(省略则跳过全部 HMI)、hmiFamily(WinCCUnifiedPC)、hmiSoftwarePath、connectionName、udt、globalDb、tagTable、hmiScreens、hmiTags、compile、save。不要发明新键。
2. 从零建工程时不要写 projectPath。
3. udt / globalDb 的对象形状:
   {"name":"UDT_Status","members":[{"name":"Active","datatype":"Bool","commentZhCn":"运行标志"},{"name":"State","datatype":"Int","startValue":"0"}]}
4. tagTable 的对象形状:
   {"name":"Tags","tags":[{"name":"Motor_Start","dataType":"Bool","logicalAddress":"%I0.0","commentZhCn":"启动按钮"}]}
5. hmiTags 尽量用绝对地址(%M.. / %DB..);HMI 画面 width/height 用面板原生分辨率,文字用独立 Text 项(不要写在 Rectangle 上)。
6. 不确定的可选键就省略(用默认值),不要瞎填。不要试图用 JSON 表达复杂代码逻辑。
7. projectName 用英文或拼音,不要中文。
示例(启停工程):
{"projectName":"StartStop_Demo","plcName":"PLC_1","plcFamily":"S7-1500","udt":[{"name":"UDT_BasicStatus","members":[{"name":"Active","datatype":"Bool","commentZhCn":"运行标志"},{"name":"Error","datatype":"Bool","commentZhCn":"故障标志"}]}],"tagTable":[{"name":"TagTable_1","tags":[{"name":"BtnStart","dataType":"Bool","logicalAddress":"%I0.0","commentZhCn":"启动按钮"},{"name":"BtnStop","dataType":"Bool","logicalAddress":"%I0.1","commentZhCn":"停止按钮"},{"name":"Motor","dataType":"Bool","logicalAddress":"%Q0.0","commentZhCn":"电机"}]}],"compile":true,"save":true}
现在等待用户的工程描述。只输出 JSON。`;

function extractSpecJson(text) {
    const cleaned = String(text || '').replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const spec = JSON.parse(cleaned.slice(start, end + 1));
        return spec && typeof spec === 'object' && spec.projectName ? spec : null;
    } catch {
        return null;
    }
}

router.post('/scaffold', authenticateToken, localOnly, async (req, res) => {
    const user = getUserById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });

    let spec = req.body.spec && typeof req.body.spec === 'object' ? req.body.spec : null;
    let specSource = 'direct';

    if (!spec) {
        const requirement = String(req.body.requirement || '').trim();
        if (!requirement) {
            return res.status(400).json({ success: false, message: '请提供 requirement(自然语言)或 spec(JSON)' });
        }
        // spec 生成走当前用户自己的模型——与聊天同一套供应商/模型体系
        const models = listUserModels(req.user.id);
        const selectedModel = models.find(m => m.id === String(req.body.modelId || '')) || getCurrentModel(req.user.id, models);
        if (!selectedModel.id) {
            return res.status(422).json({ success: false, message: '当前账号没有已启用模型,请先在设置页保存所选模型' });
        }
        let raw;
        try {
            raw = await chatOnce({
                modelId: selectedModel.id,
                userId: req.user.id,
                messages: [
                    { role: 'system', content: SCAFFOLD_SPEC_PROMPT },
                    { role: 'user', content: requirement },
                ],
            });
        } catch (e) {
            return res.status(502).json({ success: false, message: '模型生成 spec 失败: ' + e.message });
        }
        spec = extractSpecJson(raw);
        specSource = 'ai';
        if (!spec) {
            return res.status(422).json({ success: false, message: '模型输出不是合法 spec JSON', raw: raw.slice(0, 1000) });
        }
    }

    console.log(`[MCP] 建工程 用户=${user.username} 项目=${spec.projectName} spec来源=${specSource} confirmed=${!!req.body.confirmed}`);
    const startedAt = Date.now();
    try {
        const client = getSharedClient();
        const out = await enqueueTiaOp(async () => {
            // MCP 侧 spec 参数是 string(JSON 文本),不是对象
            const specText = JSON.stringify(spec);
            const dry = await client.callTool('ScaffoldProject', { spec: specText, dryRun: true }, 180000);
            const dryReport = TiaMcpClient.jsonOf(dry) || TiaMcpClient.textOf(dry);
            let runReport = null;
            if (req.body.confirmed === true) {
                const run = await client.callTool('ScaffoldProject', { spec: specText, dryRun: false }, 600000);
                runReport = TiaMcpClient.jsonOf(run) || TiaMcpClient.textOf(run);
            }
            return { dryReport, runReport };
        });
        logTiaOperation({
            user,
            op: 'mcp:ScaffoldProject',
            target: spec.projectName,
            ms: Date.now() - startedAt,
            ok: true,
            err: null,
        });
        res.json({ success: true, specSource, spec, executed: req.body.confirmed === true, ...out });
    } catch (error) {
        logTiaOperation({ user, op: 'mcp:ScaffoldProject', target: spec.projectName, ms: Date.now() - startedAt, ok: false, err: error });
        console.error('MCP 建工程错误:', error.message);
        res.status(500).json({ success: false, spec, message: '建工程失败: ' + error.message });
    }
});


    return router;
};
