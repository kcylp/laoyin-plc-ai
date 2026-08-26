const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const createTiaRoutes = require('../routes/tia');
const createTiaMcpRoutes = require('../routes/tia-mcp');

function passAuth(req, res, next) {
    req.user = { id: 7 };
    next();
}

async function requestJson(router, method, route, body) {
    const app = express();
    app.use(express.json());
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const address = server.address();
        const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
            method,
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, json: await response.json() };
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

function postJson(router, route, body) {
    return requestJson(router, 'POST', route, body);
}

function getJson(router, route) {
    return requestJson(router, 'GET', route);
}

test('legacy TIA validation catch returns sanitized detail and a Chinese hint', async () => {
    const error = new Error('MCP 子进程退出(code=1 signal=null)');
    error.recentStderr = [
        'FATAL C:\\Users\\alice\\Portal\\startup.log',
        'Authorization: Bearer sk-live-secret',
        'Could not find TIA Portal installation path for version 21 in the registry.',
    ];
    const router = createTiaRoutes.createLegacyValidateRoutes({
        authenticateToken: passAuth,
        validatePlcXml: async () => { throw error; },
        validateLadBusinessRules: () => ({ valid: true, errors: [] }),
    });

    const response = await postJson(router, '/validate', { xml: '<Document />', lang: 'lad' });
    assert.equal(response.status, 500);
    assert.equal(response.json.success, false);
    assert.ok(Array.isArray(response.json.detail));
    assert.doesNotMatch(response.json.detail.join('\n'), /alice|sk-live-secret/);
    assert.match(response.json.detail.join('\n'), /Could not find TIA Portal installation path/);
    assert.match(response.json.hint.rootCause, /注册表.*博途安装信息/);
});

test('MCP connect catch returns the client recent stderr after sanitization', async () => {
    const client = {
        status: () => ({
            recentStderr: [
                'FATAL F:\\Private\\TiaMcpServer.startup.log',
                'api_key=abcdef1234567890',
                "Could not find DLL 'Siemens.Engineering.WinCCUnified' for TIA Portal version 21",
            ],
        }),
    };
    const router = createTiaMcpRoutes({
        authenticateToken: passAuth,
        localOnly: passAuth,
        enqueueTiaOp: fn => fn(),
        getUserById: () => ({ username: 'tester' }),
        getCurrentModel: () => null,
        listUserModels: () => [],
        llmStream: async () => {},
        mcpEnsureAttached: async () => { throw new Error('MCP 子进程退出(code=1 signal=null)'); },
        parseBlocksFromTree: () => [],
        TIA_MCP_DANGEROUS: /download|delete/i,
        getPrewarmStatus: () => ({}),
        getMcpClient: () => client,
    });

    const response = await postJson(router, '/connect', {});
    assert.equal(response.status, 500);
    assert.equal(response.json.success, false);
    assert.doesNotMatch(response.json.detail.join('\n'), /F:\\Private|abcdef1234567890/);
    assert.match(response.json.detail.join('\n'), /WinCCUnified/);
    assert.match(response.json.hint.rootCause, /WinCC Unified.*Openness.*不完整/);
});

test('MCP status catch returns sanitized diagnostics instead of the default error page', async () => {
    const startupError = new Error('MCP 子进程退出(code=1 signal=null)');
    startupError.recentStderr = [
        'FATAL C:\Users\alice\Portal\startup.log',
        'secret=should-not-leak',
        'Could not find TIA Portal installation path for version 21 in the registry.',
    ];
    const router = createTiaMcpRoutes({
        authenticateToken: passAuth,
        localOnly: passAuth,
        enqueueTiaOp: fn => fn(),
        getUserById: () => ({ username: 'tester' }),
        getCurrentModel: () => null,
        listUserModels: () => [],
        llmStream: async () => {},
        mcpEnsureAttached: async () => ({ ok: true, project: 'P1' }),
        parseBlocksFromTree: () => [],
        TIA_MCP_DANGEROUS: /download|delete/i,
        getPrewarmStatus: () => ({}),
        getMcpClient: () => { throw startupError; },
    });

    const response = await getJson(router, '/status');
    assert.equal(response.status, 500);
    assert.equal(response.json.success, false);
    assert.doesNotMatch(response.json.detail.join('\n'), /alice|should-not-leak/);
    assert.match(response.json.detail.join('\n'), /Could not find TIA Portal installation path/);
    assert.match(response.json.hint.rootCause, /注册表.*博途安装信息/);
});
