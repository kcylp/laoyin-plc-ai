let buffer = '';

function respond(msg, body) {
    process.stdout.write(JSON.stringify({ id: msg.id, ...body }) + '\n');
}

process.stdin.on('data', (chunk) => {
    buffer += String(chunk);
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);

        if (msg.op === 'ping') {
            respond(msg, { ok: true, pong: true, tiaVersion: 'V21', project: 'FakeProject' });
        } else if (msg.op === 'preflight') {
            respond(msg, {
                ok: true,
                stage: 'precheck',
                kind: msg.kind,
                path: msg.path,
                blockName: 'FB_FAKE',
                blockType: 'FB',
                language: 'SCL',
                nameTaken: false,
            });
        } else if (msg.op === 'import') {
            respond(msg, {
                ok: true,
                stage: 'done',
                kind: msg.kind,
                imported: ['FB_FAKE'],
                errorCount: 0,
                warningCount: 0,
                otherBlockErrors: 0,
                messages: [],
                overwrite: msg.overwrite === true,
            });
        } else if (msg.op === 'inventory') {
            respond(msg, { ok: true, stage: 'inventory', existingNames: ['Main'], existingCount: 1 });
        } else if (msg.op === 'fail') {
            respond(msg, { ok: false, stage: 'error', message: 'fake failure' });
        } else if (msg.op === 'hang') {
            continue;
        } else if (msg.op === 'crash') {
            process.exit(7);
        } else if (msg.op === 'shutdown') {
            respond(msg, { ok: true, stage: 'shutdown' });
            process.exit(0);
        } else {
            respond(msg, { ok: false, stage: 'error', message: 'unknown op ' + msg.op });
        }
    }
});
