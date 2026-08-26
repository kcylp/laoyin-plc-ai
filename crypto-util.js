// ============================================================
// 老殷工控PLC - API Key 加密工具
// AES-256-GCM，密钥由 JWT_SECRET 派生。Key 存库前加密，
// 返回前端永远只给掩码，绝不回传明文。
// ============================================================

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function deriveKey(secret) {
    if (typeof secret !== 'string' || secret.length < 32) {
        throw new Error('安全密钥未配置或强度不足');
    }
    return crypto.createHash('sha256').update(String(secret)).digest();
}

// 加密：返回 "iv:tag:ciphertext" 的 base64
function encrypt(plaintext, secret) {
    const key = deriveKey(secret);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
}

// 解密：输入上面格式的 base64
function decrypt(payload, secret) {
    try {
        const buf = Buffer.from(String(payload), 'base64');
        if (buf.length < 12 + 16) return null;
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(12, 28);
        const data = buf.subarray(28);
        const key = deriveKey(secret);
        const decipher = crypto.createDecipheriv(ALGO, key, iv);
        decipher.setAuthTag(tag);
        return decipher.update(data) + decipher.final('utf8');
    } catch (e) {
        return null;
    }
}

// 掩码：sk-abc...xyz，只留前4后4
function maskKey(key) {
    if (!key) return '';
    const s = String(key);
    if (s.length <= 8) return '***';
    return s.slice(0, 4) + '***' + s.slice(-4);
}

// 判断前端提交的是不是掩码（避免用掩码覆盖真实 Key）
function isMasked(key) {
    return typeof key === 'string' && /^\S{1,12}\*{3}\S{1,12}$/.test(key);
}

module.exports = { encrypt, decrypt, maskKey, isMasked };
