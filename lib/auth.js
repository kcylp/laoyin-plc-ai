const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const SECURITY_CONFIGURATION_ERROR = '启动失败：安全密钥未配置或强度不足。绿色版请通过启动器启动，不要直接运行 laoyin-server.exe。源码版请在 .env 中设置 JWT_SECRET 与 ADMIN_KEY（各不少于 32 位随机字符）。';

function isNodeTestHarness() {
    const dbPath = process.env.DB_PATH || '';
    if (!process.env.NODE_TEST_CONTEXT || !process.env.NODE_TEST_WORKER_ID || !process.env.PORT || !dbPath) return false;
    if (String(process.env.PORT) === '3000') return false;
    const tmp = path.resolve(os.tmpdir()).toLowerCase();
    const resolvedDb = path.resolve(dbPath).toLowerCase();
    return resolvedDb.indexOf(tmp + path.sep) === 0 && /\.db$/i.test(dbPath);
}

// Test harness only: node:test workers run source-mode endpoints without the
// green launcher, so they get per-process secrets only when every harness guard
// above matches. Production/source-mode runs without valid env secrets still
// fail closed in assertSecurityConfig().
function readSecret(name, minLength) {
    const value = process.env[name];
    if (typeof value === 'string' && value.length >= minLength) return value;
    return isNodeTestHarness() ? crypto.randomBytes(48).toString('base64') : value;
}

const JWT_SECRET = readSecret('JWT_SECRET', 32);
const ADMIN_KEY = readSecret('ADMIN_KEY', 16);

function assertSecurityConfig() {
    if (typeof JWT_SECRET !== 'string' || JWT_SECRET.length < 32 ||
        typeof ADMIN_KEY !== 'string' || ADMIN_KEY.length < 16) {
        console.error(SECURITY_CONFIGURATION_ERROR);
        process.exit(79);
    }
}

// ---------- 认证中间件 ----------
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: '未登录' });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ success: false, message: '登录已过期，请重新登录' });
        req.user = user;
        next();
    });
}


// ---------- 写博途：两道闸 ----------
// 闸一：只允许本机访问。博途 Openness 只能操作本机工程，远程请求一律拒绝。
function localOnly(req, res, next) {
    const ip = (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return next();
    return res.status(403).json({
        success: false,
        message: '写入博途仅允许本机操作（当前来源：' + ip + '）'
    });
}

function checkAdmin(req, res) {
    const adminKey = req.body && req.body.adminKey;
    if (!ADMIN_KEY || typeof adminKey !== 'string' || adminKey.length !== ADMIN_KEY.length) {
        res.status(403).json({ success: false, message: '管理员密钥错误' });
        return false;
    }
    const supplied = Buffer.from(adminKey, 'utf8');
    const expected = Buffer.from(ADMIN_KEY, 'utf8');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        res.status(403).json({ success: false, message: '管理员密钥错误' });
        return false;
    }
    return true;
}

module.exports = { authenticateToken, localOnly, checkAdmin, assertSecurityConfig, JWT_SECRET, ADMIN_KEY };
