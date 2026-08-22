const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

const backendFiles = [
    'server.js',
    'lib/db.js',
    'lib/mail.js',
    'lib/auth.js',
    'lib/tia-queue.js',
    'lib/tia-history.js',
    'lib/tia-mcp-helpers.js',
    'lib/models.js',
    'routes/auth.js',
    'routes/chat.js',
    'routes/ai-providers.js',
    'routes/tia.js',
    'routes/tia-mcp.js',
    'routes/admin.js',
];

function readBackendFile(file) {
    return fs.readFileSync(path.join(root, file), 'utf8');
}

function readBackendSource() {
    return backendFiles
        .map(file => `\n// FILE: ${file}\n${readBackendFile(file)}`)
        .join('\n');
}

module.exports = { backendFiles, readBackendFile, readBackendSource, root };
