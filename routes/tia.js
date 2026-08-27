const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { logTiaOperation } = require('../lib/logger');
const { sanitizeDiagnostic } = require('../lib/sanitize');
const { explainTiaError } = require('../lib/tia-error-hints');
const { getSharedClient, TiaMcpClient } = require('../tia-mcp-client');
const { readAllPlcTags } = require('../lib/plc-tag-reader');
const {
    DEFAULT_COMPILE_LOOP_SETTINGS,
    diagnoseCompileResult,
    estimateTokens,
    evaluateCompileLoop,
    extractRepairCode,
} = require('../lib/compile-diagnose');

const DEFAULT_CONFIRMATION_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const MAX_ROLLBACK_BLOCK_NAME_LENGTH = 128;

function rollbackDeletePayload(info) {
    return JSON.stringify({
        action: 'rollback-delete-new-block',
        softwarePath: info.softwarePath,
        blockName: info.blockName,
        blockPath: info.blockPath,
    });
}

function findBlockPaths(tree, blockName) {
    const paths = new Set();
    const seen = new Set();
    function visit(value) {
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (String(value.name || '').toLowerCase() === blockName.toLowerCase()) {
            const blockPath = value.path || value.blockPath || value.fullPath;
            if (typeof blockPath === 'string' && blockPath.trim()) paths.add(blockPath.trim());
        }
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        Object.values(value).forEach(visit);
    }
    visit(tree);
    return [...paths];
}

function escapeRegexLiteral(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findFilesRecursive(root) {
    const found = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) found.push(...findFilesRecursive(fullPath));
        else found.push(fullPath);
    }
    return found;
}

function lineDiff(previousContent, nextContent) {
    const previous = String(previousContent || '').split(/\r?\n/);
    const next = String(nextContent || '').split(/\r?\n/);
    const lines = [];
    const count = Math.max(previous.length, next.length);
    for (let index = 0; index < count; index += 1) {
        if (previous[index] === next[index]) continue;
        if (previous[index] !== undefined) lines.push({ type: 'remove', line: index + 1, text: previous[index] });
        if (next[index] !== undefined) lines.push({ type: 'add', line: index + 1, text: next[index] });
    }
    return lines;
}

function parseInterface(content) {
    const sections = new Map();
    const source = String(content || '');
    const sectionRe = /VAR_(INPUT|OUTPUT|IN_OUT|STAT)\b([\s\S]*?)END_VAR/gi;
    let match;
    while ((match = sectionRe.exec(source))) {
        for (const line of match[2].split(/\r?\n/)) {
            const declaration = line.match(/^\s*"?([A-Za-z_][\w]*)"?\s*:\s*([^;]+)/);
            if (declaration) sections.set(`${match[1]}:${declaration[1]}`, declaration[2].trim());
        }
    }
    return sections;
}

function interfaceDiff(previousContent, nextContent) {
    const previous = parseInterface(previousContent);
    const next = parseInterface(nextContent);
    const changes = [];
    for (const [name, type] of previous) {
        if (!next.has(name)) changes.push({ type: 'remove', name, previousType: type });
        else if (next.get(name) !== type) changes.push({ type: 'change', name, previousType: type, nextType: next.get(name) });
    }
    for (const [name, type] of next) {
        if (!previous.has(name)) changes.push({ type: 'add', name, nextType: type });
    }
    return changes;
}

async function exportExistingBlockWithMcp(info, deps) {
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laoyin-pre-overwrite-'));
    try {
        const client = deps.getMcpClient ? deps.getMcpClient() : getSharedClient();
        if (deps.mcpEnsureAttached) {
            const attached = await deps.mcpEnsureAttached(client);
            if (!attached.ok) throw new Error(attached.note || '未挂接 TIA 工程');
        }
        const result = await client.callTool('ExportBlocksAsDocuments', {
            softwarePath: info.softwarePath || 'PLC_1',
            exportPath: exportDir,
            regexName: '^' + escapeRegexLiteral(info.blockName) + '$',
            preservePath: false,
        }, 180000);
        const files = findFilesRecursive(exportDir).filter(file => /\.s7dcl$/i.test(file));
        const preferred = files.find(file => path.basename(file, path.extname(file)).toLowerCase() === String(info.blockName).toLowerCase()) || files[0];
        if (!preferred) {
            const detail = TiaMcpClient.jsonOf(result) || TiaMcpClient.textOf(result);
            throw new Error('MCP 未生成旧块导出文件: ' + JSON.stringify(detail).slice(0, 500));
        }
        return { content: fs.readFileSync(preferred, 'utf8'), filename: path.basename(preferred) };
    } finally {
        fs.rmSync(exportDir, { recursive: true, force: true });
    }
}

function tiaErrorPayload(prefix, error, xml) {
    const rawDetail = error?.recentStderr || error?.stderr || error?.detail || [];
    const detail = sanitizeDiagnostic(Array.isArray(rawDetail) ? rawDetail : String(rawDetail).split(/\r?\n/));
    const safeMessage = sanitizeDiagnostic(error?.message) || '未知错误';
    return {
        success: false,
        message: `${prefix}: ${safeMessage}`,
        detail,
        hint: explainTiaError(error?.message, detail, { xml }),
    };
}

function addValidateRoute(router, deps) {
    const { authenticateToken, validatePlcXml, validateLadBusinessRules } = deps;

// ---------- 路由: PLC XML 校验（EngineerYin XSD，按语言选对应 XSD） ----------
router.post('/validate', authenticateToken, async (req, res) => {
    const { xml, lang } = req.body;

    if (!xml || typeof xml !== 'string' || !xml.trim()) {
        return res.status(400).json({ success: false, message: 'XML 内容不能为空' });
    }
    if (xml.length > 500000) {
        return res.status(400).json({ success: false, message: 'XML 内容过长' });
    }

    try {
        const result = await validatePlcXml(xml, lang);
        const isLad = String(lang || '').toLowerCase() === 'lad' || result.lang === 'lad';
        const business = isLad ? validateLadBusinessRules(xml) : { valid: true, errors: [] };
        res.json({
            success: true,
            ...result,
            valid: result.valid && business.valid,
            businessErrors: business.errors
        });
    } catch (error) {
        console.error('XSD校验错误:', error.message);
        res.status(500).json(tiaErrorPayload('校验服务出错', error, xml));
    }
});
}

module.exports = function createTiaRoutes(deps) {
    const { db, authenticateToken, localOnly, detectPayloadKind, detectLangFromXml, validateLadBusinessRules, autoFixDuplicateWirePins, preflightImport, importToTia, enqueueTiaOp, issueTiaConfirmation, consumeTiaConfirmation, sha256, recordWriteHistory, listHistory, getHistoryVersion, getUserById, getCurrentModel, listUserModels, llmStream } = deps;
    const router = express.Router();
    const confirmationMetadata = new Map();
    const rollbackDeleteMetadata = new Map();
    const exportExistingBlock = deps.exportExistingBlock || ((info) => exportExistingBlockWithMcp(info, deps));
    const now = typeof deps.now === 'function' ? deps.now : Date.now;
    const confirmationSnapshotTtlMs = Number.isFinite(deps.confirmationSnapshotTtlMs)
        ? deps.confirmationSnapshotTtlMs
        : DEFAULT_CONFIRMATION_SNAPSHOT_TTL_MS;

    function cleanExpiredSnapshots() {
        const current = now();
        for (const [token, entry] of confirmationMetadata) {
            if (entry.expiresAt <= current) confirmationMetadata.delete(token);
        }
        for (const [token, entry] of rollbackDeleteMetadata) {
            if (entry.expiresAt <= current) rollbackDeleteMetadata.delete(token);
        }
    }

    function readRollbackDeleteTarget(req, res) {
        const softwarePath = String(req.body.softwarePath || 'PLC_1').trim() || 'PLC_1';
        const blockName = String(req.body.blockName || '').trim();
        if (!blockName || blockName.length > MAX_ROLLBACK_BLOCK_NAME_LENGTH || /[\r\n]/.test(blockName)) {
            res.status(400).json({ success: false, message: '待回滚块名无效' });
            return null;
        }
        return { softwarePath, blockName };
    }

    function readCompileLoopSettings(userId) {
        const row = db.prepare(`
            SELECT tia_auto_repair, tia_repair_max_tokens, tia_repair_max_rounds, tia_repair_skip_confirm
            FROM user_settings WHERE user_id = ?
        `).get(userId);
        return {
            autoRepair: row ? !!row.tia_auto_repair : DEFAULT_COMPILE_LOOP_SETTINGS.autoRepair,
            maxTokens: row ? row.tia_repair_max_tokens : DEFAULT_COMPILE_LOOP_SETTINGS.maxTokens,
            maxRepairRounds: row ? row.tia_repair_max_rounds : DEFAULT_COMPILE_LOOP_SETTINGS.maxRepairRounds,
            skipRepairConfirmations: row ? !!row.tia_repair_skip_confirm : DEFAULT_COMPILE_LOOP_SETTINGS.skipRepairConfirmations,
        };
    }

    function validCompileLoopSettings(input) {
        return input
            && typeof input.autoRepair === 'boolean'
            && Number.isSafeInteger(input.maxTokens)
            && input.maxTokens >= 1
            && input.maxTokens <= DEFAULT_COMPILE_LOOP_SETTINGS.maxTokens
            && Number.isSafeInteger(input.maxRepairRounds)
            && input.maxRepairRounds >= 1
            && input.maxRepairRounds <= DEFAULT_COMPILE_LOOP_SETTINGS.maxRepairRounds
            && typeof input.skipRepairConfirmations === 'boolean';
    }

    async function callTiaTool(name, args, timeoutMs) {
        const client = deps.getMcpClient ? deps.getMcpClient() : getSharedClient();
        if (deps.mcpEnsureAttached) {
            const attached = await deps.mcpEnsureAttached(client);
            if (!attached.ok) throw new Error(attached.note || '未挂接 TIA 工程');
        }
        return client.callTool(name, args, timeoutMs);
    }

    addValidateRoute(router, deps);

function checkXmlPayload(req, res) {
    const { xml } = req.body;
    if (!xml || typeof xml !== 'string' || !xml.trim()) {
        res.status(400).json({ success: false, message: '内容不能为空' });
        return null;
    }
    if (xml.length > 2000000) {
        res.status(400).json({ success: false, message: '内容过长' });
        return null;
    }

    // SCL/STL 走 ExternalSources 源码通道，没有块级 XML，跳过 XML 相关校验；
    // 语法由博途自己的编译器把关，编译错误会原样回报给用户。
    // 但结构完整性必须在这里挡住：半截源码（流式输出中断）写进去一定失败，
    // 前端已隐藏按钮，后端不能只依赖前端。
    const kind = detectPayloadKind(xml);
    if (kind !== 'xml') {
        const decl = /(?:^|\n)[^\S\r\n]*(FUNCTION_BLOCK|FUNCTION|DATA_BLOCK|ORGANIZATION_BLOCK)\b/i.exec(xml);
        if (!decl) {
            res.status(422).json({
                success: false,
                message: '源码缺少 FUNCTION_BLOCK / FUNCTION 等块声明，无法写入博途'
            });
            return null;
        }
        const endRe = new RegExp(`(?:^|\\n)[^\\S\\r\\n]*END_${decl[1].toUpperCase()}\\b`, 'i');
        if (!endRe.test(xml)) {
            res.status(422).json({
                success: false,
                message: `源码不完整：缺少配对的 END_${decl[1].toUpperCase()}，已拒绝写入`
            });
            return null;
        }
        // FC 不写返回类型时博途不产块，报错含糊。提前挡住并给出可操作提示。
        if (decl[1].toUpperCase() === 'FUNCTION') {
            const line = xml.slice(decl.index).split(/\r?\n/)[0];
            if (!/:\s*\w/.test(line)) {
                res.status(422).json({
                    success: false,
                    message: 'FUNCTION（FC）缺少返回类型声明，博途无法生成块。应写成 FUNCTION "名称" : Void'
                });
                return null;
            }
        }
        return xml;
    }

    const language = String(req.body.lang || '').toLowerCase();
    const xmlLanguage = detectLangFromXml(xml);
    if (language && xmlLanguage && language !== xmlLanguage) {
        res.status(422).json({ success: false, message: `请求语言 ${language} 与 XML 语言 ${xmlLanguage} 不一致` });
        return null;
    }
    // 写入路径不带 lang，按 XML 自身声明判定，否则 LAD 校验会被整体跳过。
    // 校验前先自动修复接线冲突：AI 常把并联汇合拆成多条 Wire，博途会拒绝整块导入。
    if ((language || xmlLanguage) === 'lad') {
        const business = validateLadBusinessRules(autoFixDuplicateWirePins(xml).xml);
        if (!business.valid) {
            // 打到服务端控制台：前端只显示摘要，排查时需要完整规则清单
            console.error('[LAD校验失败] 共 %d 条：', business.errors.length);
            business.errors.forEach(e => console.error('  网络%s [%s] %s%s',
                e.network, e.rule, e.message, e.uid ? ` uid=${e.uid}` : ''));
            res.status(422).json({ success: false, message: 'LAD 业务规则校验失败', businessErrors: business.errors });
            return null;
        }
    }
    return xml;
}

// 预检（只读）：连博途、报告将要发生什么，并发放仅此 XML 可用的一次性确认凭证。
router.post('/preflight', authenticateToken, localOnly, async (req, res) => {
    const xml = checkXmlPayload(req, res);
    if (!xml) return;
    const user = getUserById(req.user.id);
    const startedAt = Date.now();
    try {
        const r = await enqueueTiaOp(async () => {
            const result = await preflightImport(xml, req.body.lang);
            if (!result.ok || !(result.nameTaken || Number(result.existingCount) > 0)) return result;
            if (Number(result.existingCount) > 1) {
                const error = new Error('检测到多个同名块且无法唯一确定块路径，已拒绝覆盖');
                error.statusCode = 409;
                throw error;
            }
            try {
                const snapshot = await exportExistingBlock({
                    blockName: result.blockName,
                    blockPath: result.blockPath || `Program blocks/${result.blockName}`,
                    softwarePath: result.softwarePath || 'PLC_1',
                });
                return {
                    ...result,
                    previousContent: snapshot.content,
                    previousFilename: snapshot.filename,
                    diffLines: lineDiff(snapshot.content, xml),
                    interfaceChanges: interfaceDiff(snapshot.content, xml),
                };
            } catch (error) {
                error.message = '写入前快照导出失败，已拒绝覆盖: ' + error.message;
                throw error;
            }
        });
        logTiaOperation({
            user,
            op: 'preflight',
            target: r.blockName || r.blockType || req.body.lang || 'payload',
            ms: Date.now() - startedAt,
            ok: !!r.ok,
            err: r.ok ? null : (r.message || r.error),
        });
        if (!r.ok) return res.json({ success: false, ...r });
        const confirmationToken = issueTiaConfirmation(req.user.id, xml, r);
        const requestedRepairRound = Number(req.body.repairRound);
        const repairRound = Number.isSafeInteger(requestedRepairRound)
            && requestedRepairRound > 0
            && requestedRepairRound <= DEFAULT_COMPILE_LOOP_SETTINGS.maxRepairRounds
            ? requestedRepairRound
            : 0;
        cleanExpiredSnapshots();
        confirmationMetadata.set(confirmationToken, {
            blockName: r.blockName,
            blockType: r.blockType,
            language: r.language,
            content: r.previousContent,
            repairRound,
            expiresAt: now() + confirmationSnapshotTtlMs,
        });
        res.json({ success: true, ...r, confirmationToken, xmlHash: sha256(xml) });
    } catch (error) {
        logTiaOperation({ user, op: 'preflight', target: req.body.lang || 'payload', ms: Date.now() - startedAt, ok: false, err: error });
        console.error('博途预检错误:', error.message);
        res.status(error.statusCode || 500).json(tiaErrorPayload('预检失败', error, xml));
    }
});

// 写入：confirmed:true 之外还必须提供 preflight 发放的一次性确认凭证。
router.post('/import', authenticateToken, localOnly, async (req, res) => {
    const xml = checkXmlPayload(req, res);
    if (!xml) return;

    if (req.body.confirmed !== true) {
        return res.status(400).json({ success: false, message: '缺少用户确认（confirmed），已拒绝写入' });
    }

    const confirmation = consumeTiaConfirmation(req.user.id, xml, req.body.confirmationToken);
    const snapshotToken = String(req.body.confirmationToken || '');
    const confirmationEntry = confirmationMetadata.get(snapshotToken);
    confirmationMetadata.delete(snapshotToken);
    const snapshotExpired = !!confirmationEntry && confirmationEntry.expiresAt <= now();
    const confirmationMeta = snapshotExpired ? null : confirmationEntry;
    if (!confirmation) {
        return res.status(409).json({ success: false, message: '预检确认已失效或与当前 XML 不匹配，已拒绝写入' });
    }

    const user = getUserById(req.user.id);
    console.log(`[写博途] 用户=${user ? user.username : req.user.id} 块=${confirmation.blockName} overwrite=${!!req.body.overwrite}`);

    const startedAt = Date.now();
    try {
        if (req.body.overwrite === true) {
            if (snapshotExpired) {
                return res.status(409).json({ success: false, message: '写入前快照已过期，请重新预检后再覆盖' });
            }
            if (!confirmationMeta || confirmationMeta.content == null) {
                return res.status(409).json({ success: false, message: '覆盖确认缺少写入前快照，已拒绝写入' });
            }
            recordWriteHistory(req.user.id, {
                ...confirmationMeta,
                kind: 'pre-overwrite',
                overwrite: false,
            });
        }
        const r = await enqueueTiaOp(() => importToTia(xml, req.body.overwrite === true));
        console.log(`[写博途] 结果 ok=${r.ok} stage=${r.stage || ''} ${r.message || ''}`);
        logTiaOperation({
            user,
            op: 'import',
            target: r.blockName || confirmation.blockName,
            ms: Date.now() - startedAt,
            ok: !!r.ok,
            err: r.ok ? null : (r.message || r.error),
        });
        if (r.ok) {
            // 写入成功留快照:块名/类型/通道/内容,供历史查看与回滚
            recordWriteHistory(req.user.id, {
                blockName: r.blockName || confirmation.blockName,
                blockType: r.blockType || confirmation.blockType,
                kind: confirmationMeta && confirmationMeta.repairRound > 0
                    ? `repair-round-${confirmationMeta.repairRound}`
                    : (r.kind || ''),
                language: r.language || '',
                content: xml,
                overwrite: req.body.overwrite === true,
            });
        }
        res.json({ success: !!r.ok, ...r });
    } catch (error) {
        logTiaOperation({ user, op: 'import', target: confirmation.blockName, ms: Date.now() - startedAt, ok: false, err: error });
        console.error('博途导入错误:', error.message);
        res.status(500).json(tiaErrorPayload('导入失败', error, xml));
    }
});

// 流水线新建块没有写入前快照，只能删除；删除必须先只读定位，再消费一次性确认令牌。
router.post('/rollback/delete-preflight', authenticateToken, localOnly, async (req, res) => {
    const target = readRollbackDeleteTarget(req, res);
    if (!target) return;
    const user = getUserById(req.user.id);
    const startedAt = Date.now();
    try {
        const treeResult = await enqueueTiaOp(
            () => callTiaTool('GetSoftwareTree', { softwarePath: target.softwarePath }, 60000),
            { label: `定位待回滚新建块 ${target.blockName}`, userId: req.user.id },
        );
        const tree = TiaMcpClient.jsonOf(treeResult) || {};
        const paths = findBlockPaths(tree, target.blockName);
        if (paths.length === 0) return res.status(404).json({ success: false, message: `未找到待删除块 ${target.blockName}` });
        if (paths.length > 1) return res.status(409).json({ success: false, message: `检测到多个同名块 ${target.blockName}，已拒绝删除` });
        const info = { ...target, blockPath: paths[0] };
        const payload = rollbackDeletePayload(info);
        const confirmationToken = issueTiaConfirmation(req.user.id, payload, {
            blockName: info.blockName,
            blockType: 'rollback-delete',
        });
        cleanExpiredSnapshots();
        rollbackDeleteMetadata.set(confirmationToken, {
            ...info,
            expiresAt: now() + confirmationSnapshotTtlMs,
        });
        logTiaOperation({ user, op: 'compile-loop:rollback-delete-preflight', target: info.blockPath, ms: Date.now() - startedAt, ok: true, err: null });
        res.json({ success: true, ...info, confirmationToken });
    } catch (error) {
        logTiaOperation({ user, op: 'compile-loop:rollback-delete-preflight', target: target.blockName, ms: Date.now() - startedAt, ok: false, err: error });
        res.status(error.statusCode || 500).json(tiaErrorPayload('删除预检失败', error));
    }
});

router.post('/rollback/delete', authenticateToken, localOnly, async (req, res) => {
    const target = readRollbackDeleteTarget(req, res);
    if (!target) return;
    if (req.body.confirmed !== true) {
        return res.status(400).json({ success: false, message: '缺少用户确认（confirmed），已拒绝删除' });
    }
    const token = String(req.body.confirmationToken || '');
    const metadata = rollbackDeleteMetadata.get(token);
    rollbackDeleteMetadata.delete(token);
    const validMetadata = metadata
        && metadata.expiresAt > now()
        && metadata.softwarePath === target.softwarePath
        && metadata.blockName === target.blockName;
    const confirmation = validMetadata
        ? consumeTiaConfirmation(req.user.id, rollbackDeletePayload(metadata), token)
        : null;
    if (!confirmation) {
        return res.status(409).json({ success: false, message: '删除确认已失效或与当前块不匹配，已拒绝删除' });
    }

    const user = getUserById(req.user.id);
    const startedAt = Date.now();
    try {
        const result = await enqueueTiaOp(
            () => callTiaTool('DeleteBlock', { softwarePath: metadata.softwarePath, blockName: metadata.blockName }, 60000),
            { label: `删除新建块 ${metadata.blockName}`, userId: req.user.id },
        );
        const parsed = TiaMcpClient.jsonOf(result) || {};
        logTiaOperation({ user, op: 'compile-loop:rollback-delete', target: metadata.blockPath, ms: Date.now() - startedAt, ok: true, err: null });
        res.json({ success: true, deleted: parsed.deleted !== false, blockName: metadata.blockName, blockPath: metadata.blockPath });
    } catch (error) {
        logTiaOperation({ user, op: 'compile-loop:rollback-delete', target: metadata.blockPath, ms: Date.now() - startedAt, ok: false, err: error });
        res.status(error.statusCode || 500).json(tiaErrorPayload('删除新建块失败', error));
    }
});

router.get('/compile-loop/settings', authenticateToken, (req, res) => {
    try {
        res.json({ success: true, settings: readCompileLoopSettings(req.user.id) });
    } catch (error) {
        res.status(500).json({ success: false, message: '自动修复设置读取失败: ' + error.message });
    }
});

router.post('/compile-loop/settings', authenticateToken, (req, res) => {
    if (!validCompileLoopSettings(req.body)) {
        return res.status(400).json({
            success: false,
            message: '设置无效：token 上限须为 1-100000，修复轮次须为 1-5，开关须为布尔值',
        });
    }
    try {
        db.prepare(`
            INSERT INTO user_settings (
                user_id, tia_auto_repair, tia_repair_max_tokens,
                tia_repair_max_rounds, tia_repair_skip_confirm, updated_at
            ) VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))
            ON CONFLICT(user_id) DO UPDATE SET
                tia_auto_repair = excluded.tia_auto_repair,
                tia_repair_max_tokens = excluded.tia_repair_max_tokens,
                tia_repair_max_rounds = excluded.tia_repair_max_rounds,
                tia_repair_skip_confirm = excluded.tia_repair_skip_confirm,
                updated_at = excluded.updated_at
        `).run(
            req.user.id,
            req.body.autoRepair ? 1 : 0,
            req.body.maxTokens,
            req.body.maxRepairRounds,
            req.body.skipRepairConfirmations ? 1 : 0,
        );
        res.json({ success: true, settings: readCompileLoopSettings(req.user.id) });
    } catch (error) {
        res.status(500).json({ success: false, message: '自动修复设置保存失败: ' + error.message });
    }
});

router.post('/compile', authenticateToken, localOnly, async (req, res) => {
    const softwarePath = String(req.body.softwarePath || 'PLC_1').trim() || 'PLC_1';
    const user = getUserById(req.user.id);
    const startedAt = Date.now();
    try {
        const result = await enqueueTiaOp(
            () => callTiaTool('CompileAndDiagnosePlc', { softwarePath }, 300000),
            { label: `编译 ${req.body.blockName || softwarePath}`, userId: req.user.id },
        );
        const parsed = TiaMcpClient.jsonOf(result) || {};
        const rawErrors = Array.isArray(parsed.errors)
            ? parsed.errors.map(String)
            : (Array.isArray(parsed.rawMessages) ? parsed.rawMessages.filter(item => /^\s*Error\b/i.test(String(item))).map(String) : []);
        const rawWarnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [];
        const diagnosis = diagnoseCompileResult({ messages: rawErrors });
        logTiaOperation({
            user,
            op: 'compile-loop:compile',
            target: req.body.blockName || softwarePath,
            ms: Date.now() - startedAt,
            ok: rawErrors.length === 0,
            err: rawErrors,
        });
        res.json({
            success: true,
            state: parsed.state || (rawErrors.length ? 'Error' : 'Success'),
            errorCount: Number.isFinite(parsed.errorCount) ? parsed.errorCount : rawErrors.length,
            warningCount: Number.isFinite(parsed.warningCount) ? parsed.warningCount : rawWarnings.length,
            diagnosis,
            rawErrors,
            rawWarnings,
            rawMessages: Array.isArray(parsed.rawMessages) ? parsed.rawMessages.map(String) : [...rawErrors, ...rawWarnings],
        });
    } catch (error) {
        logTiaOperation({ user, op: 'compile-loop:compile', target: req.body.blockName || softwarePath, ms: Date.now() - startedAt, ok: false, err: error });
        res.status(error.statusCode || 500).json(tiaErrorPayload('编译失败', error));
    }
});

router.post('/repair', authenticateToken, localOnly, async (req, res) => {
    const code = typeof req.body.code === 'string' ? req.body.code : '';
    const rawErrors = Array.isArray(req.body.rawErrors) ? req.body.rawErrors.map(String) : [];
    const diagnosis = Array.isArray(req.body.diagnosis) ? req.body.diagnosis : [];
    if (!code.trim() || rawErrors.length === 0) {
        return res.status(400).json({ success: false, message: '修复请求必须包含完整代码和编译错误原文' });
    }

    const settings = readCompileLoopSettings(req.user.id);
    const loop = evaluateCompileLoop({
        repairRound: req.body.repairRound,
        tokenUsed: req.body.tokenUsed,
        lastCode: code,
        rawErrors,
        previousRawErrors: req.body.previousRawErrors,
    }, settings);
    if (loop.stop) {
        return res.json({
            success: false,
            stopped: true,
            stopReason: loop.stopReason,
            message: loop.message,
            repairRound: loop.repairRound,
            tokenUsed: loop.tokenUsed,
            lastCode: loop.lastCode,
            rawErrors: loop.rawErrors,
        });
    }

    const models = listUserModels(req.user.id);
    const selectedModel = getCurrentModel(req.user.id, models);
    if (!selectedModel || !selectedModel.id) {
        return res.status(422).json({ success: false, message: '当前账号没有已启用模型，请先在设置中配置模型' });
    }

    const user = getUserById(req.user.id);
    const startedAt = Date.now();
    try {
        const softwarePath = String(req.body.softwarePath || 'PLC_1');
        let tagEvidence;
        try {
            const tagTables = await enqueueTiaOp(
                () => readAllPlcTags(deps.getMcpClient ? deps.getMcpClient() : getSharedClient(), { softwarePath }),
                { label: '读取 PLC 变量表用于自动修复', userId: req.user.id },
            );
            tagEvidence = JSON.stringify(tagTables, null, 2);
        } catch (error) {
            tagEvidence = `变量表读取失败：${error.message}\n不得假设变量存在，必须仅依据已知代码和编译错误修复。`;
        }
        const prompt = [
            '请修复下面这份 TIA Portal PLC 代码。只返回完整、可写入的修复后代码，不要省略任何段落。',
            '必须依据结构化诊断、编译错误原文和 PLC 变量表修复，不得虚构变量。',
            '',
            '【原始完整代码】',
            code,
            '',
            '【结构化诊断】',
            JSON.stringify(diagnosis, null, 2),
            '',
            '【编译错误原文（完整）】',
            rawErrors.join('\n'),
            '',
            '【PLC 变量表读取结果】',
            tagEvidence,
        ].join('\n');
        let streamed = '';
        const returned = await llmStream({
            modelId: selectedModel.id,
            userId: req.user.id,
            messages: [
                { role: 'system', content: '你是西门子 TIA Portal PLC 代码修复助手。输出必须是完整代码。' },
                { role: 'user', content: prompt },
            ],
            onDelta: delta => { streamed += String(delta || ''); },
        });
        const modelText = String(returned || streamed);
        const repairedCode = extractRepairCode(modelText);
        if (!repairedCode) throw new Error('模型未返回可用的完整修复代码');
        const repairRound = loop.repairRound + 1;
        const tokenUsed = loop.tokenUsed + estimateTokens(prompt) + estimateTokens(modelText);
        logTiaOperation({
            user,
            op: 'compile-loop:repair',
            target: req.body.blockName || 'PLC code',
            ms: Date.now() - startedAt,
            ok: true,
            err: null,
            detail: { repairRound, tokenUsed, modelId: selectedModel.id },
        });
        res.json({
            success: true,
            code: repairedCode,
            repairRound,
            tokenUsed,
            rawErrors,
            settings,
        });
    } catch (error) {
        logTiaOperation({ user, op: 'compile-loop:repair', target: req.body.blockName || 'PLC code', ms: Date.now() - startedAt, ok: false, err: error });
        res.status(error.statusCode || 500).json({ success: false, message: '自动修复失败: ' + error.message, lastCode: code, rawErrors });
    }
});

// ---------- 写入历史(查看/回滚) ----------
// 列表(不含 content):?blockName= 过滤某块,否则返回最近 50 条。
// 取版本 /:id 返回完整内容,前端拿到后走标准预检→确认→写入流程回滚。
router.get('/history', authenticateToken, (req, res) => {
    const blockName = String(req.query.blockName || '').trim();
    const user = getUserById(req.user.id);
    const startedAt = Date.now();
    try {
        const rows = listHistory(req.user.id, blockName);
        logTiaOperation({ user, op: 'history', target: blockName || 'latest', ms: Date.now() - startedAt, ok: true, err: null });
        res.json({ success: true, history: rows });
    } catch (error) {
        logTiaOperation({ user, op: 'history', target: blockName || 'latest', ms: Date.now() - startedAt, ok: false, err: error });
        console.error('写入历史查询错误:', error.message);
        res.status(500).json({ success: false, message: '历史查询失败: ' + error.message });
    }
});

router.get('/history/:id', authenticateToken, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: '无效版本 ID' });
    const user = getUserById(req.user.id);
    const startedAt = Date.now();
    try {
        const row = getHistoryVersion(req.user.id, id);
        if (!row) return res.status(404).json({ success: false, message: '版本不存在' });
        logTiaOperation({ user, op: 'history:detail', target: row.block_name || id, ms: Date.now() - startedAt, ok: true, err: null });
        res.json({ success: true, version: { id: row.id, blockName: row.block_name, blockType: row.block_type, kind: row.kind, language: row.language, content: row.content, overwrite: !!row.overwrite, createdAt: row.created_at } });
    } catch (error) {
        logTiaOperation({ user, op: 'history:detail', target: id, ms: Date.now() - startedAt, ok: false, err: error });
        console.error('历史版本读取错误:', error.message);
        res.status(500).json({ success: false, message: '版本读取失败: ' + error.message });
    }
});

    return router;
};

module.exports.createLegacyValidateRoutes = function createLegacyValidateRoutes(deps) {
    const router = express.Router();
    addValidateRoute(router, deps);
    return router;
};
