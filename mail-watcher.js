// ============================================================
// 老殷工控PLC - 邮件审批监听（IMAP 轮询）
// 老板直接回复审批邮件，回复内容含「同意/approve/通过」或
// 「不同意/reject/拒绝」，系统自动更新用户状态并通知用户。
// 仅当配置了 SMTP_PASS（QQ 授权码）时启动；未配置则回退纯链接审批。
// 依赖懒加载：imap/mailparser 装不上时不影响平台主流程。
// ============================================================

let db = null;
let notify = null;          // server.js 注入：审批后给用户发通知邮件
let imap = null;
let timer = null;
let reconnectTimer = null;
let stopped = false;
let Imap = null;            // 懒加载，避免依赖缺失时拖垮平台
let simpleParser = null;

const POLL_INTERVAL_MS = 30000;   // 每 30 秒查一次未读
const RECONNECT_DELAY_MS = 30000; // 断线 30 秒后重连

// 从邮件主题/正文里找用户 ID（主题或正文含 userId=42，或正文含 /api/approve?userId=42）
function extractUserId(parsed) {
    const subject = String(parsed.subject || '');
    const body = String(parsed.text || '') + ' ' + String(parsed.html || '');
    const m = subject.match(/userId[=:]\s*(\d+)/i)
        || body.match(/userId[=:]\s*(\d+)/i)
        || body.match(/\/api\/approve\?userId=(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
}

// 关键词匹配，不依赖固定格式。
// 两个坑："不同意" 含 "同意" 子串（否定必须优先）；审批链接本身含
// approve/reject 字样（先剔除 URL 再判断，避免老板粘链接时误判）。
function decideAction(text) {
    const clean = String(text || '')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/\/api\/approve\S*/gi, ' ')
        .replace(/\S*userId[=:]\s*\d+\S*/gi, ' ');
    if (/(不同意|reject|拒绝|驳回)/i.test(clean)) return 'reject';
    if (/(同意|approve|通过)/i.test(clean)) return 'approve';
    return null;
}

async function handleReply(parsed) {
    try {
        const userId = extractUserId(parsed);
        if (!userId) return;
        const action = decideAction(String(parsed.text || ''));
        if (!action) return;

        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (!user || user.status !== 'pending') {
            console.log(`[邮件审批] 用户#${userId} 不存在或已处理，忽略`);
            return;
        }

        const newStatus = action === 'approve' ? 'approved' : 'rejected';
        db.prepare('UPDATE users SET status = ? WHERE id = ?').run(newStatus, userId);
        console.log(`[邮件审批] 用户#${userId} ${user.username} -> ${newStatus === 'approved' ? '已批准' : '已拒绝'}`);

        if (notify && user.email) {
            await notify(user, newStatus);
        }
    } catch (e) {
        console.error('[邮件审批] 处理回复失败:', e.message);
    }
}

function scheduleReconnect(host, port, user, pass) {
    if (stopped) return;
    if (timer) { clearInterval(timer); timer = null; }
    if (reconnectTimer) return; // 已安排重连
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        console.log('[邮件审批] 重新连接 IMAP...');
        connect(host, port, user, pass);
    }, RECONNECT_DELAY_MS);
}

function pollOnce(host, port, user, pass) {
    if (!imap || !imap.state || imap.state !== 'authenticated') return;
    imap.search(['UNSEEN', ['FROM', user]], (err, results) => {
        if (err || !results || !results.length) return;

        const f = imap.fetch(results, { bodies: '' });
        f.on('message', (msg) => {
            msg.on('body', (stream) => {
                simpleParser(stream, (parseErr, parsed) => {
                    if (!parseErr && parsed) handleReply(parsed);
                });
            });
        });
        f.once('end', () => {
            // 已处理的标记为已读，避免重复审批
            try { imap.addFlags(results, ['\\Seen']); } catch (e) { /* ignore */ }
        });
        f.once('error', (e) => console.error('[邮件审批] 拉取邮件失败:', e.message));
    });
}

function connect(host, port, user, pass) {
    if (stopped) return;
    // TLS 默认校验证书；只有显式配置 IMAP_ALLOW_INSECURE_TLS=true 才降级（本地调试用）
    const allowInsecure = String(process.env.IMAP_ALLOW_INSECURE_TLS || '').toLowerCase() === 'true';
    try {
        imap = new Imap({
            user, password: pass, host, port,
            tls: true,
            tlsOptions: allowInsecure ? { rejectUnauthorized: false } : undefined,
            connTimeout: 30000,
            authTimeout: 30000
        });
    } catch (e) {
        console.error('[邮件审批] 创建 IMAP 连接失败:', e.message);
        scheduleReconnect(host, port, user, pass);
        return;
    }

    imap.once('ready', () => {
        console.log('[邮件审批] IMAP 已连接，开始轮询审批回复');
        // readOnly=false：以读写方式打开收件箱，处理完才能可靠标记已读（
        // 只读 EXAMINE 模式下 addFlags 不可靠，审批回复会被重复拉取）
        imap.openBox('INBOX', false, (openErr) => {
            if (openErr) {
                console.error('[邮件审批] 打开收件箱失败:', openErr.message);
                scheduleReconnect(host, port, user, pass);
                return;
            }
            timer = setInterval(() => pollOnce(host, port, user, pass), POLL_INTERVAL_MS);
            pollOnce(host, port, user, pass);
        });
    });

    imap.once('error', (e) => {
        console.error('[邮件审批] IMAP 错误:', e.message);
        scheduleReconnect(host, port, user, pass);
    });
    imap.once('end', () => {
        console.log('[邮件审批] IMAP 连接断开');
        scheduleReconnect(host, port, user, pass);
    });

    imap.connect();
}

// 启动监听。opts.notify: (user, newStatus) => Promise（发审批结果邮件给用户）
function startMailWatcher(_db, opts = {}) {
    db = _db;
    notify = opts.notify || null;

    const host = process.env.IMAP_HOST || 'imap.qq.com';
    const port = parseInt(process.env.IMAP_PORT || '993', 10);
    const user = process.env.IMAP_USER || process.env.SMTP_USER;
    const pass = process.env.IMAP_PASS || process.env.SMTP_PASS;

    if (!user || !pass) {
        console.log('[邮件审批] 未配置 SMTP_PASS/IMAP 凭据，跳过 IMAP 轮询（链接审批仍可用）');
        return { started: false, reason: 'no-credentials' };
    }

    let ImapLib, parserLib;
    try {
        ImapLib = require('imap');
        parserLib = require('mailparser');
    } catch (e) {
        console.log('[邮件审批] imap/mailparser 未安装，跳过 IMAP 轮询（链接审批仍可用）:', e.message);
        return { started: false, reason: 'deps-missing' };
    }

    // 用注入的库（避免模块顶部 require 在依赖缺失时拖垮平台）
    Imap = ImapLib;
    simpleParser = parserLib.simpleParser;

    stopped = false;
    connect(host, port, user, pass);
    return { started: true };
}

function stopMailWatcher() {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (imap) { try { imap.end(); } catch (e) { /* ignore */ } imap = null; }
}

module.exports = { startMailWatcher, stopMailWatcher, extractUserId, decideAction, handleReply };
