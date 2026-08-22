const nodemailer = require('nodemailer');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '25855835@qq.com';

// ---------- 邮箱发送 ----------
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.qq.com',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: true,
    auth: {
        user: process.env.SMTP_USER || ADMIN_EMAIL,
        pass: process.env.SMTP_PASS || ''
    }
});

// 邮件/审批页 HTML 里的用户可控字段必须 escape（防存储型 XSS 进入管理员/用户邮箱与结果页）
function htmlEscape(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function sendMail({ to, subject, html }) {
    const hasPass = process.env.SMTP_PASS;
    if (!hasPass) {
        // 未配置 SMTP 授权码：打印到服务端日志，方便本地开发调试
        console.log('\n[邮件未发送-SMTP未配置] to=' + to + ' subject=' + subject);
        console.log('  → 见下方 HTML 内容（本地调试用）\n');
        return { ok: false, preview: html };
    }
    try {
        await transporter.sendMail({
            from: `老殷工控PLC <${ADMIN_EMAIL}>`,
            to, subject, html
        });
        return { ok: true };
    } catch (e) {
        console.error('邮件发送失败:', e.message);
        console.log('  → 见下方 HTML 内容（本地调试用）\n');
        return { ok: false, preview: html };
    }
}


module.exports = { sendMail, htmlEscape, ADMIN_EMAIL };
