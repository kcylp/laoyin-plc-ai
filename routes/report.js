'use strict';

const express = require('express');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { TiaMcpClient } = require('../tia-mcp-client');
const { sanitizeDiagnostic } = require('../lib/sanitize');
const { createKnowledgeService } = require('../lib/knowledge');
const { readAllPlcTags } = require('../lib/plc-tag-reader');
const {
    buildReportModel,
    normalizeReportModel,
    buildReportMarkdown,
    renderReportHtml,
    collectKnowledgeConfirmations,
} = require('../lib/report-builder');

const execFileAsync = promisify(execFile);
const WORD_EXPORT_SCRIPT = `param([string]$InputHtml, [string]$OutputDocx)
$ErrorActionPreference = 'Stop'
$word = $null
$document = $null
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $document = $word.Documents.Open($InputHtml)
    $document.RemoveDocumentInformation(99)
    $document.SaveAs2($OutputDocx, 16)
} finally {
    if ($null -ne $document) { $document.Close($false) }
    if ($null -ne $word) { $word.Quit() }
}`;

const SETTINGS_TABLE = `
    CREATE TABLE IF NOT EXISTS report_settings (
        user_id INTEGER PRIMARY KEY,
        company_name TEXT NOT NULL DEFAULT '',
        contact TEXT NOT NULL DEFAULT '',
        project_prefix TEXT NOT NULL DEFAULT '',
        logo_data TEXT NOT NULL DEFAULT '',
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
`;

function text(value) {
    return sanitizeDiagnostic(value == null ? '' : String(value)).trim();
}

function arrayValue(value) {
    return Array.isArray(value) ? value : [];
}

function attr(item, names) {
    const attrs = arrayValue(item && item.attributes);
    const wanted = new Set(names.map(name => name.toLowerCase()));
    const found = attrs.find(entry => wanted.has(String(entry.name || '').toLowerCase()));
    return found ? found.value : '';
}

function projectFromMcp(payload, fallback = {}) {
    const source = payload && (payload.items || payload.Items);
    const item = arrayValue(source)[0] || {};
    return {
        name: text(fallback.name || fallback.projectName || item.name || attr(item, ['Name', 'ProjectName']) || '未命名工程'),
        plcName: text(fallback.plcName || attr(item, ['PlcName', 'PLCName']) || ''),
        plcFamily: text(fallback.plcFamily || attr(item, ['PlcFamily', 'PLCFamily', 'Family']) || ''),
        orderNumber: text(fallback.orderNumber || attr(item, ['OrderNumber', 'ArticleNumber']) || ''),
        firmware: text(fallback.firmware || attr(item, ['Firmware', 'FirmwareVersion']) || ''),
        tiaVersion: text(fallback.tiaVersion || attr(item, ['TiaVersion', 'Version']) || ''),
        sourcePath: text(fallback.sourcePath || attr(item, ['Path', 'ProjectPath']) || ''),
        company: text(fallback.company || fallback.companyName || ''),
        contact: text(fallback.contact || ''),
        projectNumber: text(fallback.projectNumber || ''),
    };
}

function reportSettings(db, userId) {
    const row = db.prepare('SELECT company_name, contact, project_prefix, logo_data FROM report_settings WHERE user_id = ?').get(userId);
    return {
        companyName: text(row && row.company_name),
        contact: text(row && row.contact),
        projectPrefix: text(row && row.project_prefix),
        logoData: text(row && row.logo_data),
    };
}

function saveReportSettings(db, userId, input = {}) {
    const current = reportSettings(db, userId);
    const next = {
        companyName: text(input.companyName == null ? current.companyName : input.companyName),
        contact: text(input.contact == null ? current.contact : input.contact),
        projectPrefix: text(input.projectPrefix == null ? current.projectPrefix : input.projectPrefix),
        logoData: text(input.logoData == null ? current.logoData : input.logoData),
    };
    db.prepare(`
        INSERT INTO report_settings (user_id, company_name, contact, project_prefix, logo_data, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))
        ON CONFLICT(user_id) DO UPDATE SET
            company_name = excluded.company_name,
            contact = excluded.contact,
            project_prefix = excluded.project_prefix,
            logo_data = excluded.logo_data,
            updated_at = excluded.updated_at
    `).run(userId, next.companyName, next.contact, next.projectPrefix, next.logoData);
    return next;
}

function normalizeCompileResult(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const rawMessages = arrayValue(source.rawMessages || source.messages).map(text).filter(Boolean);
    const rawErrors = arrayValue(source.rawErrors || source.errors).map(text).filter(Boolean);
    const rawWarnings = arrayValue(source.rawWarnings || source.warnings).map(text).filter(Boolean);
    const errorCount = Number.isFinite(Number(source.errorCount)) ? Number(source.errorCount) : rawErrors.length;
    const warningCount = Number.isFinite(Number(source.warningCount)) ? Number(source.warningCount) : rawWarnings.length;
    return {
        state: text(source.state || (errorCount === 0 ? 'Success' : 'Error')),
        errorCount,
        warningCount,
        rawMessages: rawMessages.length ? rawMessages : [...rawErrors, ...rawWarnings],
    };
}

function knowledgeDocsFor(input, knowledgeService, evidence = '') {
    if (Array.isArray(input.knowledgeDocs)) return input.knowledgeDocs;
    const ids = new Set(Array.isArray(input.usedBlockIds) ? input.usedBlockIds.map(String) : []);
    if (evidence && knowledgeService && typeof knowledgeService.searchKnowledge === 'function') {
        for (const match of knowledgeService.searchKnowledge(evidence, { limit: 50 }) || []) {
            if (match && match.id) ids.add(String(match.id));
        }
    }
    if (!ids.size || !knowledgeService || typeof knowledgeService.readKnowledgeDoc !== 'function') return [];
    return [...ids].map(id => {
        try { return knowledgeService.readKnowledgeDoc(id); } catch { return null; }
    }).filter(Boolean);
}

function knowledgeApplicability(doc) {
    const content = String(doc && (doc.body || doc.content) || '').replace(/\r\n/g, '\n');
    const match = content.match(/(?:^|\n)#{1,6}\s*适用场景[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s+|$)/i);
    return text(match ? match[1] : '');
}

function parseNarrativeResult(value) {
    const raw = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('模型未返回合法的报告文案 JSON');
    let parsed;
    try {
        parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
        throw new Error('模型未返回合法的报告文案 JSON');
    }
    const overview = text(parsed.overview);
    const operationLogic = text(parsed.operationLogic);
    if (!overview || !operationLogic) throw new Error('模型返回的设备方案或操作逻辑为空');
    return { overview, operationLogic };
}

async function generateNarrative({ deps, userId, project, softwareTree, tagTables, compile, history, knowledgeDocs }) {
    const { listUserModels, getCurrentModel, llmStream } = deps;
    if (typeof listUserModels !== 'function' || typeof getCurrentModel !== 'function' || typeof llmStream !== 'function') {
        const error = new Error('报告生成缺少 AI 模型服务');
        error.statusCode = 500;
        throw error;
    }
    const models = listUserModels(userId);
    const selectedModel = getCurrentModel(userId, models);
    if (!selectedModel || !selectedModel.id) {
        const error = new Error('当前账号没有已启用模型，请先在设置页保存所选模型');
        error.statusCode = 422;
        throw error;
    }
    const evidence = {
        project: {
            name: project.name,
            plcName: project.plcName,
            plcFamily: project.plcFamily,
            orderNumber: project.orderNumber,
            firmware: project.firmware,
            tiaVersion: project.tiaVersion,
        },
        softwareTree,
        tagTables,
        compile,
        writeHistory: history.map(entry => ({
            blockName: entry.block_name || entry.blockName || '',
            blockType: entry.block_type || entry.blockType || '',
            operation: entry.kind || entry.operation || '',
            overwrite: Boolean(entry.overwrite),
            createdAt: entry.created_at || entry.createdAt || '',
        })),
        knowledgeBlocks: knowledgeDocs.map(doc => ({ title: text(doc.title), applicability: knowledgeApplicability(doc) })),
    };
    let streamed = '';
    let returned;
    try {
        returned = await llmStream({
            modelId: selectedModel.id,
            userId,
            messages: [
                {
                    role: 'system',
                    content: '你是 PLC 工程交付文档撰写助手。只能依据用户提供的真实工程证据撰写，不得补造设备、地址、动作、参数或安全结论。输出严格 JSON，字段仅为 overview 和 operationLogic。信息不足时明确写“工程数据未包含”，不要猜测。',
                },
                {
                    role: 'user',
                    content: `请生成正式、简洁、可人工编辑的设备方案概述和操作逻辑说明。真实工程证据如下：\n${JSON.stringify(evidence, null, 2)}`,
                },
            ],
            onDelta: delta => { streamed += String(delta || ''); },
        });
    } catch (error) {
        const failure = new Error(`AI 报告文案生成失败：${text(error.message) || '模型调用失败'}`);
        failure.statusCode = 502;
        throw failure;
    }
    try {
        return parseNarrativeResult(String(returned || streamed));
    } catch (error) {
        error.statusCode = 502;
        throw error;
    }
}

async function exportWordWithCom(html) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'laoyin-plc-report-'));
    const htmlPath = path.join(tempDir, 'report.html');
    const docxPath = path.join(tempDir, 'report.docx');
    const scriptPath = path.join(tempDir, 'export-word.ps1');
    try {
        await Promise.all([
            fs.writeFile(htmlPath, html, 'utf8'),
            fs.writeFile(scriptPath, WORD_EXPORT_SCRIPT, 'utf8'),
        ]);
        await execFileAsync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy', 'Bypass',
            '-File', scriptPath,
            htmlPath,
            docxPath,
        ], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
        return await fs.readFile(docxPath);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

function createReportRoutes(deps = {}) {
    const {
        db,
        authenticateToken,
        localOnly,
        enqueueTiaOp,
        mcpEnsureAttached,
        getMcpClient,
        listHistory,
    } = deps;
    if (!db) throw new Error('报告路由缺少数据库依赖');
    db.exec(SETTINGS_TABLE);
    const router = express.Router();
    const requireAuth = authenticateToken || ((req, res, next) => next());
    const requireLocal = localOnly || ((req, res, next) => next());
    const getClient = getMcpClient || (() => require('../tia-mcp-client').getSharedClient());
    const runQueued = enqueueTiaOp || (fn => fn());
    const attach = mcpEnsureAttached || (async () => ({ ok: false, note: '未配置 TIA 挂接器' }));
    const knowledge = deps.knowledgeService || createKnowledgeService();
    const exportWord = deps.exportWord || exportWordWithCom;

    router.get('/settings', requireAuth, (req, res) => {
        try {
            res.json({ success: true, settings: reportSettings(db, req.user.id) });
        } catch (error) {
            res.status(500).json({ success: false, message: '交付文档设置读取失败' });
        }
    });

    router.post('/settings', requireAuth, (req, res) => {
        try {
            const settings = saveReportSettings(db, req.user.id, req.body || {});
            res.json({ success: true, settings });
        } catch (error) {
            res.status(500).json({ success: false, message: '交付文档设置保存失败' });
        }
    });

    router.post('/generate', requireAuth, requireLocal, async (req, res) => {
        const softwarePath = String(req.body.softwarePath || 'PLC_1').trim() || 'PLC_1';
        try {
            const payload = await runQueued(async () => {
                const client = getClient();
                const attached = await attach(client);
                if (!attached || !attached.ok) {
                    const error = new Error(attached && attached.note ? attached.note : '请先连接并挂接博途工程');
                    error.statusCode = 409;
                    throw error;
                }
                const projectResult = await client.callTool('GetProject', {}, 60000);
                const treeResult = await client.callTool('GetSoftwareTree', { softwarePath }, 60000);
                const tagTables = await readAllPlcTags(client, { softwarePath });
                let compileResult;
                try {
                    compileResult = await client.callTool('CompileAndDiagnosePlc', { softwarePath }, 300000);
                } catch (error) {
                    const failure = new Error(`无法获取真实编译结果：${text(error.message) || 'TIA 编译调用失败'}`);
                    failure.statusCode = error.statusCode;
                    throw failure;
                }
                const projectJson = TiaMcpClient.jsonOf(projectResult) || projectResult || {};
                const treeJson = TiaMcpClient.jsonOf(treeResult) || treeResult || {};
                const compileJson = TiaMcpClient.jsonOf(compileResult) || compileResult || {};
                return {
                    attached,
                    project: projectFromMcp(projectJson, req.body.project || {}),
                    softwareTree: text(treeJson.tree || treeJson.Tree || TiaMcpClient.textOf(treeResult)),
                    tagTables,
                    compile: normalizeCompileResult(compileJson),
                };
            }, { label: '生成交付文档', userId: req.user.id, timeoutMs: 360000 });

            const settings = reportSettings(db, req.user.id);
            const history = typeof listHistory === 'function' ? listHistory(req.user.id) : [];
            const knowledgeEvidence = [
                payload.softwareTree,
                ...history.map(entry => [entry.block_name, entry.blockName, entry.block_type, entry.blockType].filter(Boolean).join(' ')),
            ].filter(Boolean).join('\n');
            const docs = knowledgeDocsFor(req.body, knowledge, knowledgeEvidence);
            const narrative = await generateNarrative({
                deps,
                userId: req.user.id,
                project: payload.project,
                softwareTree: payload.softwareTree,
                tagTables: payload.tagTables,
                compile: payload.compile,
                history,
                knowledgeDocs: docs,
            });
            const report = buildReportModel({
                ...req.body,
                project: { ...payload.project, ...settings, projectNumber: `${settings.projectPrefix}${req.body.project?.projectNumber || ''}` },
                softwareTree: payload.softwareTree,
                tagTables: payload.tagTables,
                compile: payload.compile,
                history,
                overview: narrative.overview,
                operationLogic: narrative.operationLogic,
                knowledgeDocs: docs,
                knowledgeConfirmations: collectKnowledgeConfirmations({ knowledgeDocs: docs }),
            });
            res.json({
                success: true,
                connected: true,
                project: payload.attached.project,
                report,
                markdown: buildReportMarkdown(report),
                html: renderReportHtml(report),
            });
        } catch (error) {
            const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
            res.status(status).json({ success: false, connected: false, message: text(error.message) || '交付文档生成失败' });
        }
    });

    router.post('/export', requireAuth, requireLocal, async (req, res) => {
        const format = String(req.body.format || 'html').toLowerCase();
        const report = req.body.report;
        if (!report || typeof report !== 'object') return res.status(400).json({ success: false, message: '缺少待导出的报告内容' });
        const model = normalizeReportModel(report);
        if (format === 'markdown' || format === 'md') {
            return res.json({ success: true, format: 'markdown', filename: 'plc-delivery-report.md', content: buildReportMarkdown(model) });
        }
        const html = renderReportHtml(model);
        if (format === 'docx' || format === 'word') {
            try {
                const docx = await exportWord(html);
                return res.json({
                    success: true,
                    format: 'docx',
                    filename: 'plc-delivery-report.docx',
                    encoding: 'base64',
                    content: Buffer.from(docx).toString('base64'),
                });
            } catch {
                return res.json({
                    success: true,
                    format: 'html',
                    fallback: true,
                    filename: 'plc-delivery-report.html',
                    content: html,
                    message: 'Word COM 不可用，已降级为可在浏览器打印为 PDF 的 HTML 文档。',
                });
            }
        }
        res.json({ success: true, format: 'html', filename: 'plc-delivery-report.html', content: html });
    });

    return router;
}

module.exports = createReportRoutes;
module.exports._private = { projectFromMcp, reportSettings, saveReportSettings, normalizeCompileResult, parseNarrativeResult, exportWordWithCom };
