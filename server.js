// ============================================================
// 老殷工控PLC - 专业 PLC 编程 AI 平台
// 技术栈: Node.js + Express + 内置SQLite + 后端AI代理
// 核心能力: 邮箱审批 / 双模型 / 三系列PLC / 流式对话
// ============================================================
require('dotenv').config();
const express = require('express');
const path = require('path');
const { ensureLicense, publicStatus } = require('./license');
const licenseResult = ensureLicense();
if (!licenseResult.ok) {
    console.error(licenseResult.message);
    process.exit(78);
}
require('./lib/auth').assertSecurityConfig();
const APP_ROOT = process.env.APP_ROOT || __dirname;
const { db } = require('./lib/db');
const { backupDatabaseOnStartup } = require('./lib/db-backup');
const { sendMail, htmlEscape, ADMIN_EMAIL } = require('./lib/mail');
const { authenticateToken, localOnly, checkAdmin, JWT_SECRET, ADMIN_KEY } = require('./lib/auth');
const { installLauncherShutdown } = require('./lib/launcher-shutdown');
const models = require('./lib/models');
const queue = require('./lib/tia-queue');
const history = require('./lib/tia-history');
const mcpHelpers = require('./lib/tia-mcp-helpers');
const bridge = require('./engineer-yin-bridge');
const { getSharedClient } = require('./tia-mcp-client');
const { getSharedYinWorkerClient } = require('./yin-worker-client');
const { init: initLlm, streamChat: llmStream, listUserModels, fetchModelList, probeChatModel } = require('./llm');
const createAuthRoutes = require('./routes/auth');
const createChatRoutes = require('./routes/chat');
const createAiProviderRoutes = require('./routes/ai-providers');
const createTiaRoutes = require('./routes/tia');
const createTiaMcpRoutes = require('./routes/tia-mcp');
const createAdminRoutes = require('./routes/admin');
const createReportRoutes = require('./routes/report');
const app = express();
const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;
const registrationApprovalRequired = String(process.env.REGISTRATION_APPROVAL_REQUIRED || '').toLowerCase() === 'true';
let prewarmStatus = 'off';
initLlm(db, JWT_SECRET);
app.use(express.json({ limit: '3mb' }));
installLauncherShutdown(app, localOnly);
// ---------- 前端静态白名单：项目源码与运行数据一律不进入 HTTP 文件服务 ----------
const FRONTEND_PAGES = ['login.html', 'index.html', 'settings.html', 'admin.html', 'env-check.html', 'upgrade.html'];
const FRONTEND_ASSETS = ['login.css', 'login.js', 'admin.css', 'admin.js', 'operations.css', 'upgrade.css', 'upgrade.js', 'ai-models.js', 'plc-language.js', 'tia-confirmation.js', 'tia-import-state.js'];
function noStore(req, res, next) {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store, max-age=0, must-revalidate', Pragma: 'no-cache', Expires: '0' });
    next();
}
for (const file of [...FRONTEND_PAGES, ...FRONTEND_ASSETS]) {
    app.get('/' + file, noStore, (req, res) => res.sendFile(path.join(APP_ROOT, file)));
}
app.use('/web', noStore, express.static(path.join(APP_ROOT, 'web'), { index: false }));
app.get('/favicon.ico', noStore, (req, res) => res.status(204).end());
const deps = {
    db, sendMail, htmlEscape, ADMIN_EMAIL, authenticateToken, localOnly, checkAdmin, JWT_SECRET, ADMIN_KEY,
    ...models, ...queue, ...history, ...mcpHelpers, ...bridge,
    SITE_URL, registrationApprovalRequired, llmStream, listUserModels, fetchModelList, probeChatModel,
    getPrewarmStatus: () => prewarmStatus,
};
app.use('/api', createAuthRoutes(deps));
app.use('/api', createChatRoutes(deps));
app.use('/api/ai', createAiProviderRoutes(deps));
app.use('/api', createAdminRoutes(deps));
app.use('/api', createTiaRoutes.createLegacyValidateRoutes(deps));
app.use('/api/tia/mcp', createTiaMcpRoutes(deps));
app.use('/api/tia', createTiaRoutes(deps));
app.use('/api/report', createReportRoutes(deps));
app.get('/api/license', (req, res) => res.json(publicStatus()));
app.get('/', noStore, (req, res) => res.sendFile(path.join(APP_ROOT, 'login.html')));
app.use((err, req, res, next) => {
    console.error(`[ERROR] ${req.method} ${req.url}:`, err.message);
    res.status(500).json({ success: false, message: '服务器内部错误' });
});
app.use((req, res) => res.status(404).json({ success: false, message: '页面未找到' }));
for (const sig of ['SIGINT', 'SIGTERM', 'exit']) {
    process.on(sig, () => {
        try { getSharedClient().stop(); } catch { /* 已停 */ }
        try { getSharedYinWorkerClient({ idleStopMs: 0 }).stop(); } catch { /* 已停 */ }
    });
}
// 预热:提前拉起 headless TIA 常驻实例,让之后 Connect ~1 秒(替代每次冷启动几分钟)。
// env TIA_PREWARM=0 关闭。失败只记状态,不影响服务启动(优雅降级)。
function startTiaPrewarm() {
    if (String(process.env.TIA_PREWARM || '1') === '0') { prewarmStatus = 'off'; return; }
    prewarmStatus = 'warming';
    setTimeout(() => {
        queue.enqueueTiaOp(async () => {
            const client = getSharedClient();
            const workerClient = getSharedYinWorkerClient({ idleStopMs: 0 });
            await client.ensureReady();
            await client.callTool('Connect', {}, 300000);
            await workerClient.ensureReady();
            return mcpHelpers.mcpEnsureAttached(client);
        })
            .then((a) => {
                prewarmStatus = a.ok ? 'ready' : 'warmed-unattached';
                console.log(`[预热] 博途实例${a.ok ? '已挂接工程「' + a.project + '」' : '已就绪(未挂工程)'},后续连接秒连`);
            })
            .catch((e) => {
                prewarmStatus = 'failed';
                console.error('[预热] 失败(不影响服务):', e.message);
            });
    }, 3000);
}
app.listen(PORT, '127.0.0.1', () => {
    console.log('==============================================');
    console.log('  老殷工控PLC - PLC编程AI助手 已启动');
    console.log(`  地址: ${SITE_URL}`);
    console.log(`  管理后台: ${SITE_URL}/admin.html`);
    console.log(`  管理员邮箱: ${ADMIN_EMAIL}`);
    console.log('==============================================');
    backupDatabaseOnStartup();
    startTiaPrewarm();
    if (registrationApprovalRequired && process.env.SMTP_PASS && process.env.IMAP_HOST) {
        try {
            const { startMailWatcher } = require('./mail-watcher');
            startMailWatcher(db, {
                notify: async (user, newStatus) => {
                    if (!user.email) return;
                    const subject = newStatus === 'approved' ? '【老殷工控PLC】您的账号已通过审批' : '【老殷工控PLC】您的注册申请未通过';
                    const html = newStatus === 'approved'
                        ? `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:30px;border:1px solid #eee;border-radius:12px"><h2 style="color:#1858c4">账号已通过审批</h2><p>您好 ${htmlEscape(user.username)}，管理员已批准您的注册申请。现在可以登录 <a href="${SITE_URL}">老殷工控PLC平台</a> 开始使用了。</p></div>`
                        : `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:30px;border:1px solid #eee;border-radius:12px"><h2 style="color:#dc2626">很抱歉，您的注册申请未通过</h2><p>您好 ${htmlEscape(user.username)}，您的注册申请未通过管理员审批。如需帮助请联系管理员。</p></div>`;
                    await sendMail({ to: user.email, subject, html });
                }
            });
            console.log('  邮件审批监听：已启动');
        } catch (e) {
            console.error('邮件审批监听启动失败（不影响主流程）:', e.message);
        }
    } else {
        console.log('  邮件审批监听：未启用（免审批模式）');
    }
});
