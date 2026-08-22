const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// ---------- 数据库（内置 SQLite，零安装） ----------
const DB_PATH = process.env.DB_PATH || path.join(process.env.APP_ROOT || path.join(__dirname, '..'), 'plc_assistant.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        email TEXT,
        questions_remaining INTEGER DEFAULT 2,
        is_premium INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now','localtime'))
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS ai_providers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        wire_api TEXT DEFAULT 'auto',
        test_status TEXT NOT NULL DEFAULT 'unknown',
        test_message TEXT DEFAULT '',
        tested_at TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    )
`);

// 兼容已有数据库：ai_providers 缺测试状态字段时补列（ALTER TABLE 只执行一次，不重建表/不清数据）
const providerColumns = db.prepare('PRAGMA table_info(ai_providers)').all();
const providerColumnNames = new Set(providerColumns.map(c => c.name));
if (!providerColumnNames.has('test_status')) {
    db.exec("ALTER TABLE ai_providers ADD COLUMN test_status TEXT NOT NULL DEFAULT 'unknown'");
}
if (!providerColumnNames.has('test_message')) {
    db.exec("ALTER TABLE ai_providers ADD COLUMN test_message TEXT DEFAULT ''");
}
if (!providerColumnNames.has('tested_at')) {
    db.exec("ALTER TABLE ai_providers ADD COLUMN tested_at TEXT");
}

db.exec(`
    CREATE TABLE IF NOT EXISTS ai_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        label TEXT,
        context_length INTEGER,
        enabled INTEGER DEFAULT 1,
        test_status TEXT NOT NULL DEFAULT 'unknown',
        test_message TEXT DEFAULT '',
        tested_at TEXT
    )
`);

// 兼容已有数据库：ai_models 缺模型级测试状态字段时补列（幂等，不重建表/不清数据）
const modelColumns = db.prepare('PRAGMA table_info(ai_models)').all();
const modelColumnNames = new Set(modelColumns.map(c => c.name));
if (!modelColumnNames.has('test_status')) {
    db.exec("ALTER TABLE ai_models ADD COLUMN test_status TEXT NOT NULL DEFAULT 'unknown'");
}
if (!modelColumnNames.has('test_message')) {
    db.exec("ALTER TABLE ai_models ADD COLUMN test_message TEXT DEFAULT ''");
}
if (!modelColumnNames.has('tested_at')) {
    db.exec("ALTER TABLE ai_models ADD COLUMN tested_at TEXT");
}

db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
        user_id INTEGER PRIMARY KEY,
        current_model_id TEXT,
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
`);

// 写入历史:每次成功写入博途留一份该块当时的完整内容快照,支持查看/回滚
// (覆盖写错后能回到上一版;每块保留最近 30 条,超量删最旧)
db.exec(`
    CREATE TABLE IF NOT EXISTS tia_write_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        block_name TEXT NOT NULL,
        block_type TEXT DEFAULT '',
        kind TEXT DEFAULT '',
        language TEXT DEFAULT '',
        content TEXT NOT NULL,
        overwrite INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    )
`);

module.exports = { db, DB_PATH };
