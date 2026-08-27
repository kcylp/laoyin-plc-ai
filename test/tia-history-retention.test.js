const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');

function runHistoryScript(dbPath, script) {
    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: root,
        env: { ...process.env, DB_PATH: dbPath, APP_ROOT: root },
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('history has the user/block index and prunes per block, per user count, and per user bytes', (t) => {
    const dbPath = path.join(os.tmpdir(), `tia-history-${process.pid}-${Date.now()}.db`);
    t.after(() => fs.rmSync(dbPath, { force: true }));

    runHistoryScript(dbPath, `
        const history = require('./lib/tia-history');
        for (let i = 0; i < 35; i++) history.recordWriteHistory(1, { blockName: 'FB_A', content: 'A' + i });
        for (let i = 0; i < 12; i++) history.recordWriteHistory(1, { blockName: 'FB_' + i, content: 'X'.repeat(32) }, { maxUserEntries: 36, maxUserBytes: 400 });
        history.recordWriteHistory(2, { blockName: 'FB_OTHER', content: 'OTHER' });
    `);

    const db = new DatabaseSync(dbPath);
    try {
        const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_tia_history_user_block_id'").get();
        assert.match(index.sql, /user_id\s*,\s*block_name\s*,\s*id/i);
        assert.ok(db.prepare("SELECT COUNT(*) AS count FROM tia_write_history WHERE user_id = 1 AND block_name = 'FB_A'").get().count <= 30);
        assert.ok(db.prepare('SELECT COUNT(*) AS count FROM tia_write_history WHERE user_id = 1').get().count <= 36);
        assert.ok(db.prepare('SELECT COALESCE(SUM(length(CAST(content AS BLOB))), 0) AS bytes FROM tia_write_history WHERE user_id = 1').get().bytes <= 400);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tia_write_history WHERE user_id = 2').get().count, 1, '裁剪用户 1 不得删除用户 2 的历史');
    } finally {
        db.close();
    }
});
