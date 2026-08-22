const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('plc_assistant.db');
const rows = db.prepare("SELECT id, username FROM users WHERE username LIKE 'mcp%'").all();
console.log('found:', JSON.stringify(rows));
if (rows.length) {
    const u = db.prepare("DELETE FROM users WHERE username LIKE 'mcp%'").run();
    console.log('deleted:', u.changes);
}
db.close();
