const express = require('express');
const { logTiaOperation } = require('../lib/logger');
const { sanitizeDiagnostic } = require('../lib/sanitize');
const { explainTiaError } = require('../lib/tia-error-hints');

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
    const { db, authenticateToken, localOnly, detectPayloadKind, detectLangFromXml, validateLadBusinessRules, autoFixDuplicateWirePins, preflightImport, importToTia, enqueueTiaOp, issueTiaConfirmation, consumeTiaConfirmation, sha256, recordWriteHistory, getUserById } = deps;
    const router = express.Router();

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
        const r = await enqueueTiaOp(() => preflightImport(xml, req.body.lang));
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
        res.json({ success: true, ...r, confirmationToken, xmlHash: sha256(xml) });
    } catch (error) {
        logTiaOperation({ user, op: 'preflight', target: req.body.lang || 'payload', ms: Date.now() - startedAt, ok: false, err: error });
        console.error('博途预检错误:', error.message);
        res.status(500).json(tiaErrorPayload('预检失败', error, xml));
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
    if (!confirmation) {
        return res.status(409).json({ success: false, message: '预检确认已失效或与当前 XML 不匹配，已拒绝写入' });
    }

    const user = getUserById(req.user.id);
    console.log(`[写博途] 用户=${user ? user.username : req.user.id} 块=${confirmation.blockName} overwrite=${!!req.body.overwrite}`);

    const startedAt = Date.now();
    try {
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
                kind: r.kind || '',
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

// ---------- 写入历史(查看/回滚) ----------
// 列表(不含 content):?blockName= 过滤某块,否则返回最近 50 条。
// 取版本 /:id 返回完整内容,前端拿到后走标准预检→确认→写入流程回滚。
router.get('/history', authenticateToken, (req, res) => {
    const blockName = String(req.query.blockName || '').trim();
    const user = getUserById(req.user.id);
    const startedAt = Date.now();
    try {
        const rows = blockName
            ? db.prepare(`SELECT id, block_name, block_type, kind, language, overwrite, created_at
                          FROM tia_write_history WHERE user_id = ? AND block_name = ?
                          ORDER BY id DESC LIMIT 30`).all(req.user.id, blockName)
            : db.prepare(`SELECT id, block_name, block_type, kind, language, overwrite, created_at
                          FROM tia_write_history WHERE user_id = ?
                          ORDER BY id DESC LIMIT 50`).all(req.user.id);
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
        const row = db.prepare('SELECT * FROM tia_write_history WHERE id = ? AND user_id = ?').get(id, req.user.id);
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
