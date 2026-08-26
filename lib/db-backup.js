const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DB_PATH } = require('./db');

const APP_DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), '老殷工控PLC助手');
const BACKUP_DIR = path.join(APP_DATA_DIR, 'db-backups');
const LEGACY_BACKUP_DIR = path.join(process.env.APP_ROOT || path.join(__dirname, '..'), 'work', 'db-backups');

function copyLegacyBackupsOnce() {
    if (LEGACY_BACKUP_DIR === BACKUP_DIR || !fs.existsSync(LEGACY_BACKUP_DIR)) return;
    try {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        for (const file of fs.readdirSync(LEGACY_BACKUP_DIR)) {
            if (!/^plc_assistant\.\d{4}-\d{2}-\d{2}\.db$/.test(file)) continue;
            const src = path.join(LEGACY_BACKUP_DIR, file);
            const dst = path.join(BACKUP_DIR, file);
            if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
        }
    } catch (e) {
        console.warn('历史 DB 备份迁移失败:', e.message);
    }
}

function backupDatabaseOnStartup() {
    const backupDir = BACKUP_DIR;
    try { fs.mkdirSync(backupDir, { recursive: true }); } catch { /* ignore */ }
    copyLegacyBackupsOnce();
    const backupPath = path.join(backupDir, `plc_assistant.${new Date().toISOString().slice(0, 10)}.db`);
    try {
        fs.copyFileSync(DB_PATH, backupPath);
        console.log('DB 已备份至', backupPath);
    } catch (e) {
        console.warn('DB 备份失败:', e.message);
    }
    try {
        fs.readdirSync(backupDir)
            .filter(f => /^plc_assistant\.\d{4}-\d{2}-\d{2}\.db$/.test(f))
            .sort()
            .slice(0, -7)
            .forEach(f => fs.unlinkSync(path.join(backupDir, f)));
    } catch (e) {
        console.warn('DB 备份清理失败:', e.message);
    }
}

module.exports = { backupDatabaseOnStartup, BACKUP_DIR };
