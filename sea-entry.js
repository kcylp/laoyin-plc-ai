// Node SEA entry point. Runtime assets remain beside the executable in app/.
const path = require('node:path');
const appRoot = process.env.APP_ROOT || path.join(path.dirname(process.execPath), '..', 'app');
process.env.APP_ROOT = appRoot;
process.chdir(appRoot);
const port = Number(process.env.PORT || 3000);
const net = require('node:net');
const license = require('./license');
const result = license.ensureLicense();
if (!result.ok) {
    process.stderr.write(result.message + '\n');
    process.exitCode = 78;
} else {
    const probe = net.createServer();
    probe.once('error', () => {
        process.stderr.write('端口 ' + port + ' 已被占用，请关闭占用程序后重试。\n');
        process.exit(98);
    });
    probe.listen(port, '127.0.0.1', () => {
        probe.close(() => {
            require('./server');
        });
    });
    process.env.DB_PATH = process.env.DB_PATH || path.join(path.dirname(license.licensePath()), 'plc_assistant.db');
}
