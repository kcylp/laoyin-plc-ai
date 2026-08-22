const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

module.exports = function createAuthRoutes(deps) {
    const { db, authenticateToken, getUserByUsername, getUserById, sendMail, htmlEscape, registrationApprovalRequired, SITE_URL, ADMIN_KEY, ADMIN_EMAIL, JWT_SECRET } = deps;
    const router = express.Router();

// ---------- 路由: 注册（默认本机直接可用；需要企业审批时显式开启） ----------
router.post('/register', async (req, res) => {
    const { username, password, email } = req.body;

    if (!username || !password) return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
    if (username.length < 3) return res.status(400).json({ success: false, message: '用户名至少需要3个字符' });
    if (password.length < 6) return res.status(400).json({ success: false, message: '密码至少需要6个字符' });

    if (getUserByUsername(username)) {
        return res.status(400).json({ success: false, message: '用户名已存在' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const initialStatus = registrationApprovalRequired ? 'pending' : 'approved';
    const result = db.prepare(
        'INSERT INTO users (username, password, email, questions_remaining, is_premium, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(username, hashedPassword, email || null, -1, 1, initialStatus);

    const userId = result.lastInsertRowid;
    if (!registrationApprovalRequired) {
        return res.json({
            success: true,
            message: '注册成功！账号已开通，可以直接登录工程工作台。'
        });
    }

    // 企业审批模式：给管理员发审批邮件（可回复邮件审批，也可点链接）
    const approveUrl = `${SITE_URL}/api/approve?userId=${userId}&action=approve&adminKey=${encodeURIComponent(ADMIN_KEY)}`;
    const rejectUrl = `${SITE_URL}/api/approve?userId=${userId}&action=reject&adminKey=${encodeURIComponent(ADMIN_KEY)}`;
    const html = `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:30px;border:1px solid #eee;border-radius:12px">
            <h2 style="color:#2563eb">新用户注册待审批</h2>
            <p>有一位新用户注册了老殷工控PLC 平台：</p>
            <table style="border-collapse:collapse;width:100%;margin:16px 0">
                <tr><td style="padding:8px;background:#f5f5f5">用户名</td><td style="padding:8px"><strong>${htmlEscape(username)}</strong></td></tr>
                <tr><td style="padding:8px;background:#f5f5f5">邮箱</td><td style="padding:8px">${htmlEscape(email || '未填')}</td></tr>
                <tr><td style="padding:8px;background:#f5f5f5">注册时间</td><td style="padding:8px">${new Date().toLocaleString('zh-CN')}</td></tr>
                <tr><td style="padding:8px;background:#f5f5f5">用户ID</td><td style="padding:8px">${userId}</td></tr>
            </table>
            <p style="background:#f0f7f6;padding:12px;border-radius:8px"><strong>直接回复此邮件：</strong><br>
            回复「同意」或「approve」→ 批准该用户<br>
            回复「不同意」或「reject」→ 拒绝该用户<br>
            <span style="color:#888;font-size:12px">（系统会自动识别邮件内容并处理）</span></p>
            <p>或点击链接审批：<br>
            <a href="${approveUrl}" style="display:inline-block;margin:4px 0;background:#1858c4;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none">批准该用户</a><br>
            <a href="${rejectUrl}" style="display:inline-block;margin:4px 0;background:#dc2626;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none">拒绝该用户</a></p>
        </div>
    `;
    await sendMail({
        to: ADMIN_EMAIL,
        subject: `【新用户待审批】${htmlEscape(username)} 注册了老殷工控PLC（userId=${userId}）`,
        html
    });

    res.json({
        success: true,
        message: '注册成功！您的账号需管理员审批后才能登录，审批结果会通过邮件通知您。'
    });
});

// ---------- 路由: 登录（检查审批状态） ----------
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: '用户名和密码不能为空' });

    const user = getUserByUsername(username);
    if (!user) return res.status(400).json({ success: false, message: '用户名或密码错误' });

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(400).json({ success: false, message: '用户名或密码错误' });

    if (user.status === 'pending') {
        return res.status(403).json({ success: false, message: '您的账号正在等待管理员审批，请耐心等待邮件通知。' });
    }
    if (user.status === 'rejected') {
        return res.status(403).json({ success: false, message: '很抱歉，您的注册申请未通过审批。如需帮助请联系管理员。' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
        success: true,
        message: '登录成功',
        token,
        user: { id: user.id, username: user.username, email: user.email }
    });
});

// ---------- 路由: 审批（邮件链接直达） ----------
router.get('/approve', async (req, res) => {
    const { userId, action, adminKey } = req.query;
    if (adminKey !== ADMIN_KEY) return res.send('<h2>审批失败：管理员密钥错误</h2>');
    if (!userId || !['approve', 'reject'].includes(action)) return res.send('<h2>审批失败：参数错误</h2>');

    const user = getUserById(Number(userId));
    if (!user) return res.send('<h2>审批失败：用户不存在</h2>');
    if (user.status !== 'pending') return res.send(`<h2>该用户已经处理过（当前状态：${user.status}）</h2>`);

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(newStatus, Number(userId));

    // 通知用户审批结果
    if (user.email) {
        const subject = action === 'approve' ? '【老殷工控PLC】您的账号已通过审批' : '【老殷工控PLC】您的注册申请未通过';
        const html = action === 'approve'
            ? `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:30px;border:1px solid #eee;border-radius:12px"><h2 style="color:#1858c4">🎉 恭喜，您的账号已通过审批！</h2><p>您好 ${htmlEscape(user.username)}，管理员已批准您的注册申请。现在您可以登录 <a href="${SITE_URL}">老殷工控PLC平台</a> 开始使用了。</p></div>`
            : `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:30px;border:1px solid #eee;border-radius:12px"><h2 style="color:#dc2626">很抱歉，您的注册申请未通过</h2><p>您好 ${htmlEscape(user.username)}，您的注册申请未通过管理员审批。如需帮助，请联系管理员。</p></div>`;
        await sendMail({ to: user.email, subject, html });
    }

    res.send(`
        <div style="font-family:sans-serif;max-width:480px;margin:80px auto;padding:40px;border:1px solid #eee;border-radius:12px;text-align:center">
            <h1 style="color:${action === 'approve' ? '#1858c4' : '#dc2626'}">${action === 'approve' ? '✓ 已批准' : '✗ 已拒绝'}</h1>
            <p>用户 <strong>${htmlEscape(user.username)}</strong> 的审批状态已更新为：<strong>${newStatus === 'approved' ? '已通过' : '已拒绝'}</strong></p>
            <a href="${SITE_URL}/admin.html" style="margin-top:20px;display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">返回管理后台</a>
        </div>
    `);
});

// ---------- 路由: 验证令牌 ----------
router.get('/verify', authenticateToken, (req, res) => {
    res.json({ success: true, user: req.user });
});

// ---------- 路由: 用户信息 ----------
router.get('/user', authenticateToken, (req, res) => {
    const user = getUserById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });
    res.json({
        success: true,
        user: {
            id: user.id, username: user.username, email: user.email,
            questions_remaining: user.questions_remaining,
            is_premium: !!user.is_premium, status: user.status,
            created_at: user.created_at
        }
    });
});

    return router;
};
