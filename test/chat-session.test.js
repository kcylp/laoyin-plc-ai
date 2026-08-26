const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const createChatRoutes = require('../routes/chat');

function createDb() {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE conversations (
            user_id INTEGER PRIMARY KEY,
            messages_json TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE tia_write_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL
        );
    `);
    return db;
}

function passAuth(req, res, next) {
    req.user = { id: 42 };
    next();
}

async function serveChatRouter(deps, fn) {
    const app = express();
    app.use(express.json());
    app.use('/api', createChatRoutes({
        db: createDb(),
        authenticateToken: passAuth,
        getUserById: () => ({ id: 42, username: 'tester', status: 'approved' }),
        getCurrentModel: () => ({ id: 'fake/model', label: 'Fake Model' }),
        setCurrentModel: () => ({ ok: true, model: { id: 'fake/model', label: 'Fake Model' } }),
        listUserModels: () => [{ id: 'fake/model', label: 'Fake Model' }],
        registrationApprovalRequired: true,
        enqueueTiaOp: fn => fn(),
        mcpEnsureAttached: async () => ({ ok: false, note: 'not connected' }),
        parseBlocksFromTree: () => [],
        ...deps,
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        return await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

async function postJson(base, path, body) {
    const response = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
        body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
}

async function getJson(base, path) {
    const response = await fetch(base + path, { headers: { authorization: 'Bearer test' } });
    return { status: response.status, json: await response.json().catch(() => null) };
}

async function poll(fn, timeoutMs = 1000) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeoutMs) {
        last = await fn();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    return last;
}

test('chat persists completed turns, restores history, and clears it from SQLite', async () => {
    await serveChatRouter({
        llmStream: async ({ onDelta, signal }) => {
            assert.equal(signal.aborted, false);
            onDelta('第一段');
            onDelta('第二段');
            return '第一段第二段';
        },
    }, async base => {
        const response = await fetch(base + '/api/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
            body: JSON.stringify({ message: 'PLC 起保停程序', series: 's1200', lang: 'scl', includeContext: false }),
        });
        assert.equal(response.status, 200);
        const sse = await response.text();
        assert.match(sse, /"type":"delta"/);
        assert.match(sse, /"type":"done"/);

        const history = await getJson(base, '/api/chat/history');
        assert.equal(history.status, 200);
        assert.deepEqual(history.json.messages, [
            { role: 'user', content: 'PLC 起保停程序' },
            { role: 'assistant', content: '第一段第二段' },
        ]);

        const cleared = await postJson(base, '/api/chat/clear', {});
        assert.equal(cleared.status, 200);
        const empty = await getJson(base, '/api/chat/history');
        assert.deepEqual(empty.json.messages, []);
    });
});

test('chat abort propagates to llmStream and persists the interrupted marker', async () => {
    let signalSeen = null;
    let abortObserved;
    const abortPromise = new Promise(resolve => { abortObserved = resolve; });

    await serveChatRouter({
        llmStream: ({ signal }) => new Promise((resolve, reject) => {
            signalSeen = signal;
            signal.addEventListener('abort', () => {
                abortObserved();
                const error = new Error('aborted');
                error.name = 'AbortError';
                error.code = 'ABORT_ERR';
                reject(error);
            }, { once: true });
        }),
    }, async base => {
        const controller = new AbortController();
        const response = await fetch(base + '/api/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
            body: JSON.stringify({ message: 'PLC 长回答', series: 's1200', lang: 'scl', includeContext: false }),
            signal: controller.signal,
        });
        assert.equal(response.status, 200);
        assert.ok(signalSeen);

        controller.abort();
        await abortPromise;
        assert.equal(signalSeen.aborted, true);

        const saved = await poll(async () => {
            const history = await getJson(base, '/api/chat/history');
            return history.json.messages.length ? history.json.messages : null;
        });
        assert.deepEqual(saved, [
            { role: 'user', content: 'PLC 长回答' },
            { role: 'assistant', content: '[用户已中断]' },
        ]);
    });
});
