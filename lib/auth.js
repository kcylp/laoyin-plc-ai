const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

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
    const { adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) {
        res.status(403).json({ success: false, message: '管理员密钥错误' });
        return false;
    }
    return true;
}

module.exports = { authenticateToken, localOnly, checkAdmin, JWT_SECRET, ADMIN_KEY };
