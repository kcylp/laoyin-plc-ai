const express = require('express');
const { runDiagnose, exportDiagnosticPackage } = require('../lib/env-diagnose');
const { getSharedClient, TiaMcpClient } = require('../tia-mcp-client');

module.exports = function createAdminRoutes(deps) {
    const {
        db,
        checkAdmin = () => false,
        getUserById = () => null,
        getUserByUsername = () => null,
        sendMail = async () => {},
        htmlEscape = value => String(value),
        authenticateToken = (req, res) => res.status(500).json({ success: false, message: '鉴权中间件未配置' }),
        localOnly = (req, res) => res.status(500).json({ success: false, message: '本机限制中间件未配置' }),
        enqueueTiaOp = fn => fn(),
        getMcpClient = getSharedClient,
        envDiagnoseDeps = {},
    } = deps || {};
    const router = express.Router();

async function runMaybeQueued(deep, fn) {
    return deep ? enqueueTiaOp(fn) : fn();
}

// ---------- 路由: 环境自检（首次引导用） ----------
router.get('/env-check', authenticateToken, localOnly, async (req, res) => {
    try {
        const deep = req.query.deep === '1' || req.query.deep === 'true';
        const result = await runMaybeQueued(deep, () => runDiagnose({ deep, deps: { db, ...envDiagnoseDeps } }));
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/diagnose/export', authenticateToken, localOnly, async (req, res) => {
    try {
        const deep = req.body && req.body.deep === true;
        const result = await runMaybeQueued(deep, () => exportDiagnosticPackage({ deep, deps: { db, ...envDiagnoseDeps } }));
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/env-check/fix', authenticateToken, localOnly, async (req, res) => {
    if (!req.body || req.body.id !== 'openness-group') {
        return res.status(400).json({ success: false, message: '不支持的自动修复项' });
    }
    try {
        const result = await enqueueTiaOp(async () => {
            const client = getMcpClient();
            await client.ensureReady();
            const response = await client.callTool('EnsureOpennessUserGroup', {}, 60000);
            return TiaMcpClient.jsonOf(response) || response;
        });
        res.json({ success: true, id: 'openness-group', result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 管理员验证（供 admin.html 登录）
router.post('/admin/verify', (req, res) => {
    if (!checkAdmin(req, res)) return;
    res.json({ success: true, message: '验证成功' });
});

// 用户列表（含审批状态）
router.post('/admin/get-users', (req, res) => {
    if (!checkAdmin(req, res)) return;
    const users = db.prepare('SELECT id, username, email, questions_remaining, is_premium, status, created_at FROM users ORDER BY created_at DESC').all();
    res.json({ success: true, users });
});

// 审批/拒绝用户
router.post('/admin/approve', (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { userId, action } = req.body;
    if (!userId || !['approve', 'reject'].includes(action)) {
        return res.status(400).json({ success: false, message: '参数错误' });
    }
    const user = getUserById(Number(userId));
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(newStatus, Number(userId));

    // 通知用户
    if (user.email) {
        const subject = action === 'approve' ? '【老殷工控PLC】您的账号已通过审批' : '【老殷工控PLC】您的注册申请未通过';
        const html = action === 'approve'
            ? `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:30px;border:1px solid #eee;border-radius:12px"><h2 style="color:#1858c4">🎉 恭喜，您的账号已通过审批！</h2><p>您好 ${htmlEscape(user.username)}，现在可以登录使用了。</p></div>`
            : `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:30px;border:1px solid #eee;border-radius:12px"><h2 style="color:#dc2626">很抱歉，您的注册申请未通过</h2><p>您好 ${htmlEscape(user.username)}，请联系管理员。</p></div>`;
        sendMail({ to: user.email, subject, html });
    }

    res.json({ success: true, message: `已${newStatus === 'approved' ? '批准' : '拒绝'}用户 ${user.username}` });
});

// 更新问题次数 / 付费状态（保留原功能）
router.post('/admin/update-questions', (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { username, questionsToAdd, questionsToReduce, setPremium } = req.body;
    if (!username) return res.status(400).json({ success: false, message: '用户名不能为空' });

    const user = getUserByUsername(username);
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });

    if (setPremium !== undefined) {
        db.prepare('UPDATE users SET is_premium = ? WHERE id = ?').run(setPremium ? 1 : 0, user.id);
    } else if (questionsToAdd !== undefined) {
        db.prepare('UPDATE users SET questions_remaining = questions_remaining + ? WHERE id = ?').run(parseInt(questionsToAdd), user.id);
    } else if (questionsToReduce !== undefined) {
        db.prepare('UPDATE users SET questions_remaining = MAX(0, questions_remaining - ?) WHERE id = ?').run(parseInt(questionsToReduce), user.id);
    } else {
        return res.status(400).json({ success: false, message: '请提供要更新的数据' });
    }

    res.json({ success: true, message: '更新成功' });
});


    return router;
};
