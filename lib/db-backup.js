const fs = require('node:fs');
const path = require('node:path');
const { DB_PATH } = require('./db');

function backupDatabaseOnStartup() {
    const backupDir = path.join(process.env.APP_ROOT || path.join(__dirname, '..'), 'work', 'db-backups');
    try { fs.mkdirSync(backupDir, { recursive: true }); } catch { /* ignore */ }
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

module.exports = { backupDatabaseOnStartup };
