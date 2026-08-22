const express = require('express');
const { checkOpennessEnvironment } = require('../engineer-yin-bridge');
const { getSharedClient } = require('../tia-mcp-client');

module.exports = function createAdminRoutes(deps) {
    const { db, checkAdmin, getUserById, getUserByUsername, sendMail, htmlEscape } = deps;
    const router = express.Router();

// ---------- 路由: 环境自检（首次引导用） ----------
router.get('/env-check', async (req, res) => {
    try {
        const env = await checkOpennessEnvironment();
        // 补上模型供应状态：查有没有可用的供应商/模型
        let aiReady = false;
        let providerCount = 0;
        try {
            providerCount = db.prepare('SELECT COUNT(*) c FROM ai_providers').get().c;
            const modelCount = db.prepare('SELECT COUNT(*) c FROM ai_models WHERE enabled=1').get().c;
            aiReady = modelCount > 0;
        } catch (e) { /* 表可能不存在 */ }
        // 邮件审批：SMTP 授权码配了才算可用（IMAP 复用同一授权码）
        const mailConfigured = !!(process.env.SMTP_PASS || process.env.IMAP_PASS);
        // 博途在线引擎(vendored MCP 运行时):只查 exe 在不在,不启动(启动很慢)
        const mcpAvailable = getSharedClient().available();
        const issues = [];
        if (!env.opennessPath) issues.push('博途未检测');
        if (!env.inOpennessGroup) issues.push('未加入 Openness 组');
        if (!aiReady) issues.push('AI 未配置');
        if (!env.moduleFound) issues.push('引擎缺失');
        if (!mcpAvailable) issues.push('在线引擎未集成');
        const healthScore = Math.max(0, 100 - issues.length * 20);
        res.json({ success: true, ...env, aiReady, providerCount, mailConfigured, mcpAvailable, healthScore, issues });
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
