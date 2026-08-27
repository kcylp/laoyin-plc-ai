'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseBlocksFromTree } = require('./tia-mcp-helpers');
const { sanitizeDiagnostic } = require('./sanitize');

const FIXED_SAFETY_WARNING = '⚠️ 编译 0 错误 ≠ 上机能跑。本程序为 AI 辅助生成的草稿，必须由具备资质的工程师在博途中逐网络人工审查、并经 PLCSIM 仿真验证后，方可下载至真实设备。急停与安全回路必须由硬接线安全继电器实现，程序中的联锁仅为辅助。人员防护（安全光栅、围栏、双手启动等）须由机械/安全专业另行设计。';
const GENERIC_CONFIRMATIONS = [
    '逐点核对 I/O 分配表与现场实际接线。',
    '急停回路与安全功能由安全专业设计并现场验证，不依赖本程序。',
    '已在博途中逐网络人工审查，并经 PLCSIM 仿真验证完整流程和异常分支。',
];
const FALLBACK_TEMPLATE = {
    title: 'PLC 程序设计交付文档',
    documentNotice: '本文档描述的 PLC 程序由 AI 辅助生成，属于工程草稿。编译通过不代表逻辑、接线、整定值或安全要求已经验证。',
    sections: [
        { id: 'overview', title: '设备方案' },
        { id: 'program', title: '程序结构' },
        { id: 'io', title: 'I/O 分配' },
        { id: 'operation', title: '操作逻辑说明' },
        { id: 'compile', title: '编译结论' },
        { id: 'safety', title: '上机前必须现场确认' },
        { id: 'history', title: '修改履历' },
        { id: 'appendix', title: '附录 A：完整变量表' },
    ],
};

function text(value) {
    return sanitizeDiagnostic(value == null ? '' : String(value)).trim();
}

function firstValue(source, keys, fallback = '') {
    for (const key of keys) {
        if (source && source[key] != null && String(source[key]).trim()) return source[key];
    }
    return fallback;
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function cleanLogoData(value) {
    const candidate = String(value == null ? '' : value).trim();
    return /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=\r\n]+$/i.test(candidate) ? candidate : '';
}

function loadDefaultTemplate() {
    try {
        const file = path.join(__dirname, '..', 'templates', 'report', 'default.json');
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed.sections) && parsed.sections.length) return parsed;
    } catch { /* packaged fallback below */ }
    return FALLBACK_TEMPLATE;
}

function flattenTagTables(tables) {
    const source = asArray(tables);
    const flattened = [];
    for (const table of source) {
        const tags = asArray(firstValue(table, ['tags', 'Tags', 'items', 'Items'], []));
        for (const tag of tags) {
            flattened.push({
                table: text(firstValue(table, ['name', 'Name', 'tableName', 'TableName'], '')),
                name: text(firstValue(tag, ['name', 'Name', 'tagName', 'TagName'], '')),
                dataType: text(firstValue(tag, ['dataType', 'DataType', 'type', 'Type'], '')),
                logicalAddress: text(firstValue(tag, ['logicalAddress', 'LogicalAddress', 'address', 'Address'], '')),
                comment: text(firstValue(tag, ['comment', 'Comment', 'description', 'Description'], '')),
            });
        }
    }
    return flattened.filter(tag => tag.name || tag.logicalAddress);
}

function collectKnowledgeConfirmations({ usedBlockIds = [], knowledgeDocs = [] } = {}) {
    const used = new Set(asArray(usedBlockIds).map(String));
    const output = [];
    for (const doc of asArray(knowledgeDocs)) {
        if (used.size && !used.has(String(doc.id)) && !used.has(String(doc.title))) continue;
        const content = String(doc.content || doc.body || '');
        const heading = content.match(/(?:^|\n)#{1,6}\s*(?:上机前必须确认|现场确认)[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s+|$)/i);
        const section = heading ? heading[1] : '';
        for (const line of section.split(/\r?\n/)) {
            const item = line.replace(/^\s*(?:[-*+] |\[[ xX]\] |\d+[.)] )/, '').trim();
            if (item) output.push(text(item));
        }
    }
    return [...new Set(output.filter(Boolean))];
}

function compileSummary(compile = {}) {
    const errors = Number.isFinite(Number(compile.errorCount)) ? Number(compile.errorCount) : asArray(compile.rawErrors || compile.errors).length;
    const warnings = Number.isFinite(Number(compile.warningCount)) ? Number(compile.warningCount) : asArray(compile.rawWarnings || compile.warnings).length;
    const state = text(compile.state || (errors === 0 ? 'Success' : 'Error'));
    return `${state}: ${errors} errors, ${warnings} warnings`;
}

function buildReportModel(input = {}) {
    const project = input.project || {};
    const allTags = flattenTagTables(input.tagTables || input.tables);
    const ioTags = allTags.filter(tag => /^%?[IQ]/i.test(tag.logicalAddress));
    const blocks = parseBlocksFromTree(input.softwareTree || input.tree || '');
    const knowledgeConfirmations = input.knowledgeConfirmations || collectKnowledgeConfirmations(input);
    const history = asArray(input.history).map(entry => ({
        id: entry.id,
        blockName: text(firstValue(entry, ['block_name', 'blockName'], '')),
        blockType: text(firstValue(entry, ['block_type', 'blockType'], '')),
        operation: text(firstValue(entry, ['kind', 'operation'], '写入')) || '写入',
        overwrite: Boolean(entry.overwrite),
        operator: text(firstValue(entry, ['operator', 'username', 'user'], '')),
        createdAt: text(firstValue(entry, ['created_at', 'createdAt'], '')),
    }));
    return {
        project: Object.fromEntries(Object.entries({
            name: firstValue(project, ['name', 'projectName', 'project_name'], '未命名工程'),
            plcName: firstValue(project, ['plcName', 'plc_name'], ''),
            plcFamily: firstValue(project, ['plcFamily', 'plc_family'], ''),
            orderNumber: firstValue(project, ['orderNumber', 'order_number'], ''),
            firmware: firstValue(project, ['firmware', 'firmwareVersion'], ''),
            tiaVersion: firstValue(project, ['tiaVersion', 'tia_version'], ''),
            company: firstValue(project, ['company', 'companyName'], ''),
            contact: firstValue(project, ['contact', 'contactInfo'], ''),
            projectNumber: firstValue(project, ['projectNumber', 'project_number'], ''),
            sourcePath: firstValue(project, ['sourcePath', 'projectPath'], ''),
        }).map(([key, value]) => [key, text(value)])),
        logoData: cleanLogoData(input.logoData || firstValue(project, ['logoData', 'logo_data'], '')),
        overview: text(input.overview || '根据已连接 TIA 工程的真实软件树和变量表编制。'),
        operationLogic: text(input.operationLogic || '请结合现场工艺、设备动作和操作规程完成最终说明。'),
        programBlocks: blocks,
        ioTags,
        allTags,
        history,
        compile: {
            summary: compileSummary(input.compile),
            rawMessages: asArray(input.compile && (input.compile.rawMessages || input.compile.messages)).map(text).filter(Boolean),
        },
        knowledgeConfirmations: [...new Set(GENERIC_CONFIRMATIONS.concat(knowledgeConfirmations.map(text)).filter(Boolean))],
        safetyWarning: FIXED_SAFETY_WARNING,
        generatedAt: text(input.generatedAt || new Date().toISOString()),
    };
}

function normalizeReportModel(input = {}) {
    if (!input.project || !Array.isArray(input.programBlocks) || !Array.isArray(input.allTags)) {
        return buildReportModel(input);
    }
    const project = input.project || {};
    const normalizeTag = tag => ({
        table: text(tag && tag.table),
        name: text(tag && tag.name),
        dataType: text(tag && tag.dataType),
        logicalAddress: text(tag && tag.logicalAddress),
        comment: text(tag && tag.comment),
    });
    const knowledgeConfirmations = asArray(input.knowledgeConfirmations).map(text).filter(Boolean);
    return {
        project: Object.fromEntries(Object.entries({
            name: firstValue(project, ['name', 'projectName', 'project_name'], '未命名工程'),
            plcName: firstValue(project, ['plcName', 'plc_name'], ''),
            plcFamily: firstValue(project, ['plcFamily', 'plc_family'], ''),
            orderNumber: firstValue(project, ['orderNumber', 'order_number'], ''),
            firmware: firstValue(project, ['firmware', 'firmwareVersion'], ''),
            tiaVersion: firstValue(project, ['tiaVersion', 'tia_version'], ''),
            company: firstValue(project, ['company', 'companyName'], ''),
            contact: firstValue(project, ['contact', 'contactInfo'], ''),
            projectNumber: firstValue(project, ['projectNumber', 'project_number'], ''),
            sourcePath: firstValue(project, ['sourcePath', 'projectPath'], ''),
        }).map(([key, value]) => [key, text(value)])),
        logoData: cleanLogoData(input.logoData || firstValue(project, ['logoData', 'logo_data'], '')),
        overview: text(input.overview),
        operationLogic: text(input.operationLogic),
        programBlocks: asArray(input.programBlocks).map(block => ({
            name: text(block && block.name),
            type: text(block && block.type),
            lang: text(block && block.lang),
            path: text(block && block.path),
        })),
        ioTags: asArray(input.ioTags).map(normalizeTag),
        allTags: asArray(input.allTags).map(normalizeTag),
        history: asArray(input.history).map(entry => ({
            id: entry && entry.id,
            blockName: text(entry && entry.blockName),
            blockType: text(entry && entry.blockType),
            operation: text(entry && entry.operation) || '写入',
            overwrite: Boolean(entry && entry.overwrite),
            operator: text(entry && entry.operator),
            createdAt: text(entry && entry.createdAt),
        })),
        compile: {
            summary: text(input.compile && input.compile.summary) || compileSummary(input.compile),
            rawMessages: asArray(input.compile && input.compile.rawMessages).map(text).filter(Boolean),
        },
        knowledgeConfirmations: [...new Set(GENERIC_CONFIRMATIONS.concat(knowledgeConfirmations))],
        safetyWarning: FIXED_SAFETY_WARNING,
        generatedAt: text(input.generatedAt || new Date().toISOString()),
    };
}

function md(value) {
    return text(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function sectionLines(id, r) {
    switch (id) {
        case 'overview':
            return [r.overview];
        case 'program':
            return [
                '| 块名 | 类型 | 编程语言 | 路径 |',
                '|---|---|---|---|',
                ...r.programBlocks.map(block => `| ${md(block.name)} | ${md(block.type)} | ${md(block.lang)} | ${md(block.path)} |`),
                ...(r.programBlocks.length ? [] : ['| 未读取到 | | | |']),
            ];
        case 'io':
            return [
                '| 地址 | 符号名 | 类型 | 说明 |',
                '|---|---|---|---|',
                ...r.ioTags.map(tag => `| ${md(tag.logicalAddress)} | ${md(tag.name)} | ${md(tag.dataType)} | ${md(tag.comment)} |`),
                ...(r.ioTags.length ? [] : ['| 未读取到 | | | |']),
            ];
        case 'operation':
            return [r.operationLogic];
        case 'compile':
            return [r.compile.summary, ...r.compile.rawMessages.map(message => `- ${md(message)}`)];
        case 'safety':
            return [`> ${r.safetyWarning}`, '', ...r.knowledgeConfirmations.map(item => `- [ ] ${md(item)}`)];
        case 'history':
            return [
                '| 时间 | 块名 | 类型 | 操作 | 覆盖 | 操作人 |',
                '|---|---|---|---|---|---|',
                ...r.history.map(item => `| ${md(item.createdAt)} | ${md(item.blockName)} | ${md(item.blockType)} | ${md(item.operation)} | ${item.overwrite ? '是' : '否'} | ${md(item.operator)} |`),
                ...(r.history.length ? [] : ['| 暂无记录 | | | | | |']),
            ];
        case 'appendix':
            return [
                '| 表 | 地址 | 符号名 | 类型 | 说明 |',
                '|---|---|---|---|---|',
                ...r.allTags.map(tag => `| ${md(tag.table)} | ${md(tag.logicalAddress)} | ${md(tag.name)} | ${md(tag.dataType)} | ${md(tag.comment)} |`),
                ...(r.allTags.length ? [] : ['| 未读取到 | | | | |']),
            ];
        default:
            return [];
    }
}

function buildReportMarkdown(report, template = loadDefaultTemplate()) {
    const r = normalizeReportModel(report);
    const p = r.project;
    const lines = [
        `# ${md(template.title || FALLBACK_TEMPLATE.title)}`,
        '',
        `- 项目名称：${md(p.name)}`,
        `- PLC：${md(p.plcName)} ${md(p.plcFamily)}`.trim(),
        `- 固件版本：${md(p.firmware)}`,
        `- 项目编号：${md(p.projectNumber)}`,
        `- 编制单位：${md(p.company)} ${md(p.contact)}`.trim(),
        `- 生成时间：${md(r.generatedAt)}`,
        '',
        '## 文档说明',
        md(template.documentNotice || FALLBACK_TEMPLATE.documentNotice),
    ];
    for (const section of asArray(template.sections)) {
        const content = sectionLines(String(section.id || ''), r);
        if (!content.length) continue;
        lines.push('', `## ${md(section.title || section.id)}`, ...content);
    }
    return lines.join('\n');
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function parseMarkdownRow(line) {
    const source = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells = [];
    let cell = '';
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (char === '\\' && source[index + 1] === '|') {
            cell += '|';
            index += 1;
        } else if (char === '|') {
            cells.push(cell.trim());
            cell = '';
        } else {
            cell += char;
        }
    }
    cells.push(cell.trim());
    return cells;
}

function markdownToHtml(markdown) {
    const lines = markdown.split('\n');
    const output = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.startsWith('|')) {
            const rows = [];
            while (index < lines.length && lines[index].startsWith('|')) {
                rows.push(parseMarkdownRow(lines[index]));
                index += 1;
            }
            index -= 1;
            const hasHeader = rows.length > 1 && rows[1].every(cell => /^:?-{3,}:?$/.test(cell));
            const header = hasHeader ? rows.shift() : null;
            if (hasHeader) rows.shift();
            output.push('<table>');
            if (header) output.push(`<thead><tr>${header.map(cell => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead>`);
            output.push(`<tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`);
            output.push('</table>');
            continue;
        }
        if (line.startsWith('# ')) output.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
        else if (line.startsWith('## ')) output.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
        else if (line.startsWith('> ')) output.push(`<blockquote>${escapeHtml(line.slice(2))}</blockquote>`);
        else if (/^- \[ \] /.test(line)) output.push(`<p class="check">☐ ${escapeHtml(line.slice(6))}</p>`);
        else if (line.startsWith('- ')) output.push(`<p>${escapeHtml(line.slice(2))}</p>`);
        else output.push(line ? `<p>${escapeHtml(line)}</p>` : '');
    }
    return output.join('\n');
}

function renderReportHtml(report) {
    const r = normalizeReportModel(report);
    const title = escapeHtml(r.project.name || 'PLC 程序设计交付文档');
    const logo = r.logoData ? `<img class="company-logo" src="${r.logoData}" alt="公司 Logo">` : '';
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>@page{size:A4;margin:18mm}body{font-family:"Microsoft YaHei",sans-serif;color:#172321;line-height:1.65}h1{font-size:24px;border-bottom:2px solid #1858c4;padding-bottom:8px}h2{font-size:17px;margin-top:24px;border-bottom:1px solid #cbd5e1;padding-bottom:4px}blockquote{border-left:4px solid #d97706;background:#fff7ed;padding:10px 14px;margin:12px 0}.check{margin:5px 0}table{width:100%;border-collapse:collapse;table-layout:fixed;margin:10px 0 18px;font-size:11px}th,td{border:1px solid #94a3b8;padding:5px 7px;text-align:left;vertical-align:top;word-break:break-word}th{background:#e8eef8;font-weight:700}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}header,footer{color:#475569;font-size:10px}.company-logo{display:block;max-width:160px;max-height:48px;margin-bottom:8px;object-fit:contain}@media print{.no-print{display:none}h2{break-after:avoid}blockquote,table,tr{break-inside:avoid}}</style></head><body><header>${logo}${escapeHtml(r.project.company)} · ${escapeHtml(r.project.contact)}</header>${markdownToHtml(buildReportMarkdown(r))}<footer>${escapeHtml(r.project.company)} · ${escapeHtml(r.project.projectNumber)}</footer></body></html>`;
}

module.exports = {
    FIXED_SAFETY_WARNING,
    GENERIC_CONFIRMATIONS,
    buildReportModel,
    normalizeReportModel,
    buildReportMarkdown,
    renderReportHtml,
    collectKnowledgeConfirmations,
    flattenTagTables,
    loadDefaultTemplate,
};
