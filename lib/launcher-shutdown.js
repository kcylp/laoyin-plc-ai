function installLauncherShutdown(app, localOnly) {
    app.post('/api/system/shutdown', localOnly, (req, res) => {
        const expected = process.env.LAUNCHER_SHUTDOWN_TOKEN || '';
        const actual = String(req.headers['x-launcher-token'] || '');
        if (!expected || actual !== expected) {
            return res.status(403).json({ success: false, message: '拒绝操作' });
        }
        res.json({ success: true });
        setTimeout(() => process.exit(0), 100);
    });
}

module.exports = { installLauncherShutdown };
