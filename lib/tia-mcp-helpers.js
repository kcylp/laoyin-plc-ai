const { TiaMcpClient } = require('../tia-mcp-client');

// ---------- TIA MCP(vendored TiaMcpServer.exe):能力合并层 ----------
// 架构:我们的 Node 后端当 MCP 客户端,常驻子进程跑 vendor 的 TiaMcpServer.exe,
// 201 个工具(建项目/硬件/下载/在线读值/HMI/编译诊断)全部经 /api/tia/mcp/call 可达。
// 防冲突三条:
//  1) 串行:所有碰博途的操作(我们的 preflight/import + MCP connect/call)进同一
//     互斥队列 enqueueTiaOp,任何时刻只有一个操作在驱动博途
//  2) 同实例:MCP 侧用 Connect + AttachToOpenProject 挂到用户已打开的博途 GUI
//     实例与项目,与「发送至博途」写的是同一个工程
//  3) 只有冻结清单内的只读工具可免确认；未知工具默认要求 confirmed:true
const manifest = require('../engine/tia-mcp/manifest/tools-list.json');
const READ_ONLY_PREFIX = /^(Get|List|Read|Check|Describe|Search|Query|Find)/;
const READ_ONLY_TIA_MCP_TOOLS = new Set(
    manifest.tools.map(tool => tool.name).filter(name => READ_ONLY_PREFIX.test(name))
);

function requiresTiaMcpConfirmation(name) {
    const normalized = typeof name === 'string' ? name : '';
    if (/^Export/.test(normalized)) return true;
    if (['SaveProject', 'SaveAsProject', 'CompileSoftware', 'CompileAndDiagnosePlc'].includes(normalized)) return true;
    return !READ_ONLY_TIA_MCP_TOOLS.has(normalized);
}

// 确保在线引擎连上同一个已打开的工程(Connect → 挑 IsPrimary → Attach)。
// 返回 { ok, project, note }。多个端点共用,避免各写各的 attach 逻辑。
async function mcpEnsureAttached(client) {
    await client.callTool('Connect', {}, 300000);
    const proj = await client.callTool('GetProject', {}, 60000);
    const items = (TiaMcpClient.jsonOf(proj) || {}).items || [];
    const attr = (p, n) => {
        const a = (p.attributes || []).find(x => x.name === n);
        return a ? a.value : undefined;
    };
    const target = items.find(p => attr(p, 'IsPrimary') === true) || items[0];
    if (!target || !target.name) {
        return { ok: false, project: '', note: '博途里没有已打开的项目' };
    }
    await client.callTool('AttachToOpenProject', { projectName: target.name }, 60000);
    return { ok: true, project: target.name, note: '' };
}

function parseBlocksFromTree(tree) {
    const lines = String(tree || '').replace(/```/g, '').split(/\r?\n/);
    const blocks = [];
    let inProgram = false;
    let programDepth = -1;
    const groups = [];
    for (const line of lines) {
        const node = line.match(/^((?:│   |    )*)(?:├── |└── )(.*)$/);
        if (!node) continue;
        const depth = node[1].length / 4;
        const label = node[2].trim();
        if (label === 'Program blocks') {
            inProgram = true;
            programDepth = depth;
            groups.length = 0;
            continue;
        }
        if (!inProgram) continue;
        if (depth <= programDepth) break;

        const groupCount = depth - programDepth - 1;
        groups.length = Math.min(groups.length, groupCount);
        const m = label.match(/^(.+?)\s*\[(OB\d+|FB\d+|FC\d+|DB\d+)[,\s]*([^\]]*)\]/);
        if (!m) {
            groups[groupCount] = label;
            continue;
        }
        const name = m[1].trim();
        blocks.push({
            name,
            type: m[2],
            lang: (m[3] || '').trim(),
            path: ['Program blocks', ...groups.slice(0, groupCount), name].join('/'),
        });
    }
    return blocks;
}

module.exports = { READ_ONLY_TIA_MCP_TOOLS, requiresTiaMcpConfirmation, mcpEnsureAttached, parseBlocksFromTree };
