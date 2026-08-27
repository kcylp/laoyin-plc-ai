const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const createTiaRoutes = require('../routes/tia');
const TAG_FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'TASK014_Acceptance_IO.xml'), 'utf8');

const openDbs = new Set();
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

test.beforeEach(() => {
    console.log = () => {};
    console.error = () => {};
});

test.afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    for (const db of openDbs) {
        try { db.close(); } catch { /* already closed */ }
    }
    openDbs.clear();
});

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
        const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
            method,
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, json: await response.json() };
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

function createDeps(overrides = {}) {
    let issuedPreflight = null;
    const db = new DatabaseSync(':memory:');
    openDbs.add(db);
    db.exec(`
        CREATE TABLE user_settings (
            user_id INTEGER PRIMARY KEY,
            current_model_id TEXT,
            tia_auto_repair INTEGER NOT NULL DEFAULT 0,
            tia_repair_max_tokens INTEGER NOT NULL DEFAULT 100000,
            tia_repair_max_rounds INTEGER NOT NULL DEFAULT 5,
            tia_repair_skip_confirm INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT
        )
    `);
    return {
        db,
        authenticateToken: passAuth,
        localOnly: passAuth,
        detectPayloadKind: () => 's7dcl',
        detectLangFromXml: () => 'scl',
        validateLadBusinessRules: () => ({ valid: true, errors: [] }),
        autoFixDuplicateWirePins: xml => ({ xml }),
        preflightImport: async () => ({
            ok: true,
            blockName: 'FB_Motor',
            blockType: 'FB',
            language: 'scl',
            nameTaken: true,
            existingCount: 1,
            softwarePath: 'PLC_1',
            blockPath: 'Program blocks/FB_Motor',
        }),
        importToTia: async () => ({ ok: true, blockName: 'FB_Motor', blockType: 'FB', language: 'scl' }),
        enqueueTiaOp: fn => fn(),
        issueTiaConfirmation: (userId, xml, preflight) => {
            issuedPreflight = preflight;
            return 'confirm-1';
        },
        consumeTiaConfirmation: () => issuedPreflight && ({
            blockName: issuedPreflight.blockName,
            blockType: issuedPreflight.blockType,
        }),
        sha256: () => 'hash-1',
        recordWriteHistory: () => {},
        listHistory: () => [],
        getHistoryVersion: () => null,
        getUserById: () => ({ username: 'tester' }),
        getCurrentModel: () => ({ id: 'fake/model', label: 'Fake Model' }),
        listUserModels: () => [{ id: 'fake/model', label: 'Fake Model' }],
        llmStream: async ({ onDelta }) => {
            const code = '```scl\nFUNCTION_BLOCK "FB_Motor"\nBEGIN\nEND_FUNCTION_BLOCK\n```';
            onDelta(code);
            return code;
        },
        mcpEnsureAttached: async () => ({ ok: true, project: 'Demo' }),
        getMcpClient: () => ({
            callTool: async () => ({ content: [{ type: 'text', text: '{}' }] }),
        }),
        exportExistingBlock: async () => ({
            content: 'FUNCTION_BLOCK "FB_Motor"\nVAR_INPUT\n OldStart : Bool;\nEND_VAR\nEND_FUNCTION_BLOCK',
            filename: 'FB_Motor.s7dcl',
        }),
        ...overrides,
    };
}

const NEW_CODE = 'FUNCTION_BLOCK "FB_Motor"\nVAR_INPUT\n Start : Bool;\nEND_VAR\nEND_FUNCTION_BLOCK';

test('same-name preflight exports the old block and import records it before overwrite', async () => {
    const events = [];
    const deps = createDeps({
        exportExistingBlock: async info => {
            events.push(['export', info.blockName, info.blockPath]);
            return { content: 'OLD-COMPLETE-CONTENT', filename: 'FB_Motor.s7dcl' };
        },
        recordWriteHistory: (userId, info) => events.push(['history', userId, info]),
        importToTia: async () => {
            events.push(['import']);
            return { ok: true, blockName: 'FB_Motor', blockType: 'FB', language: 'scl' };
        },
    });
    const router = createTiaRoutes(deps);

    const pre = await requestJson(router, 'POST', '/preflight', { xml: NEW_CODE, lang: 'scl' });
    assert.equal(pre.status, 200);
    assert.equal(pre.json.success, true);
    assert.equal(pre.json.previousContent, 'OLD-COMPLETE-CONTENT');
    assert.ok(Array.isArray(pre.json.diffLines));
    assert.ok(Array.isArray(pre.json.interfaceChanges));

    const imported = await requestJson(router, 'POST', '/import', {
        xml: NEW_CODE,
        confirmed: true,
        overwrite: true,
        confirmationToken: pre.json.confirmationToken,
    });
    assert.equal(imported.json.success, true);
    assert.deepEqual(events.map(event => event[0]), ['export', 'history', 'import', 'history']);
    assert.equal(events[1][2].kind, 'pre-overwrite');
    assert.equal(events[1][2].content, 'OLD-COMPLETE-CONTENT');
});

test('same-name preflight fails closed when the old block cannot be exported', async () => {
    let issued = false;
    let imported = false;
    const router = createTiaRoutes(createDeps({
        exportExistingBlock: async () => { throw new Error('export failed'); },
        issueTiaConfirmation: () => { issued = true; return 'must-not-issue'; },
        importToTia: async () => { imported = true; return { ok: true }; },
    }));

    const response = await requestJson(router, 'POST', '/preflight', { xml: NEW_CODE, lang: 'scl' });
    assert.equal(response.status, 500);
    assert.equal(response.json.success, false);
    assert.match(response.json.message, /写入前快照|导出/);
    assert.equal(issued, false);
    assert.equal(imported, false);
});

test('same-name preflight refuses overwrite when more than one block path matches', async () => {
    let exported = false;
    const router = createTiaRoutes(createDeps({
        preflightImport: async () => ({
            ok: true,
            blockName: 'FB_Motor',
            blockType: 'FB',
            language: 'scl',
            nameTaken: true,
            existingCount: 2,
            softwarePath: 'PLC_1',
        }),
        exportExistingBlock: async () => {
            exported = true;
            return { content: 'OLD', filename: 'FB_Motor.s7dcl' };
        },
    }));

    const response = await requestJson(router, 'POST', '/preflight', { xml: NEW_CODE, lang: 'scl' });
    assert.equal(response.status, 409);
    assert.equal(response.json.success, false);
    assert.match(response.json.message, /多个同名块|路径/);
    assert.equal(exported, false);
});

test('overwrite refuses a confirmation whose pre-overwrite snapshot has expired', async () => {
    let now = 1000;
    let imported = false;
    const router = createTiaRoutes(createDeps({
        now: () => now,
        confirmationSnapshotTtlMs: 50,
        importToTia: async () => {
            imported = true;
            return { ok: true };
        },
    }));

    const pre = await requestJson(router, 'POST', '/preflight', { xml: NEW_CODE, lang: 'scl' });
    now += 51;
    const response = await requestJson(router, 'POST', '/import', {
        xml: NEW_CODE,
        confirmed: true,
        overwrite: true,
        confirmationToken: pre.json.confirmationToken,
    });

    assert.equal(response.status, 409);
    assert.equal(response.json.success, false);
    assert.match(response.json.message, /快照.*过期/);
    assert.equal(imported, false);
});

test('history routes delegate to listHistory and getHistoryVersion', async () => {
    const calls = [];
    const router = createTiaRoutes(createDeps({
        listHistory: (userId, blockName) => {
            calls.push(['list', userId, blockName]);
            return [{ id: 3, block_name: 'FB_Motor' }];
        },
        getHistoryVersion: (userId, id) => {
            calls.push(['get', userId, id]);
            return { id, block_name: 'FB_Motor', content: 'OLD' };
        },
    }));

    const list = await requestJson(router, 'GET', '/history?blockName=FB_Motor');
    const detail = await requestJson(router, 'GET', '/history/3');

    assert.equal(list.json.history[0].id, 3);
    assert.equal(detail.json.version.content, 'OLD');
    assert.deepEqual(calls, [['list', 7, 'FB_Motor'], ['get', 7, 3]]);
});

test('compile-loop settings default to the approved limits, validate updates, and stay user isolated', async () => {
    const deps = createDeps();
    const router = createTiaRoutes(deps);

    const defaults = await requestJson(router, 'GET', '/compile-loop/settings');
    assert.equal(defaults.status, 200);
    assert.deepEqual(defaults.json.settings, {
        autoRepair: false,
        maxTokens: 100000,
        maxRepairRounds: 5,
        skipRepairConfirmations: false,
    });

    const invalid = await requestJson(router, 'POST', '/compile-loop/settings', {
        autoRepair: true,
        maxTokens: 0,
        maxRepairRounds: 6,
        skipRepairConfirmations: true,
    });
    assert.equal(invalid.status, 400);

    const saved = await requestJson(router, 'POST', '/compile-loop/settings', {
        autoRepair: true,
        maxTokens: 12000,
        maxRepairRounds: 2,
        skipRepairConfirmations: true,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.settings, {
        autoRepair: true,
        maxTokens: 12000,
        maxRepairRounds: 2,
        skipRepairConfirmations: true,
    });
    assert.equal(deps.db.prepare('SELECT COUNT(*) AS count FROM user_settings WHERE user_id = 8').get().count, 0);
});

test('compile runs through the TIA queue and returns structured diagnosis plus complete raw errors', async () => {
    const events = [];
    const rawErrors = [
        'Error Path=FB_Motor Network=2 Line=18: Tag "StartCmd" not defined',
        'Error Path=FB_Motor Network=3 Line=22: Type mismatch: cannot convert TIME to INT',
    ];
    const router = createTiaRoutes(createDeps({
        enqueueTiaOp: async (fn, options) => {
            events.push(['queue', options]);
            return fn();
        },
        getMcpClient: () => ({
            callTool: async (name, args) => {
                events.push(['tool', name, args]);
                return {
                    content: [{ type: 'text', text: JSON.stringify({
                        state: 'Error',
                        errorCount: 2,
                        warningCount: 0,
                        errors: rawErrors,
                        warnings: [],
                        rawMessages: ['State=Error; Path=PLC_1', ...rawErrors],
                    }) }],
                };
            },
        }),
    }));

    const response = await requestJson(router, 'POST', '/compile', { softwarePath: 'PLC_1', blockName: 'FB_Motor' });
    assert.equal(response.status, 200);
    assert.equal(response.json.success, true);
    assert.equal(response.json.errorCount, 2);
    assert.deepEqual(response.json.rawErrors, rawErrors);
    assert.equal(response.json.diagnosis.length, 2);
    assert.equal(response.json.diagnosis[0].type, 'tag-not-defined');
    assert.deepEqual(events.map(item => item[0]), ['queue', 'tool']);
    assert.equal(events[1][1], 'CompileAndDiagnosePlc');
    assert.deepEqual(events[1][2], { softwarePath: 'PLC_1' });
});

test('repair uses the current user model and includes complete code, diagnosis, errors, and tag tables', async () => {
    const captured = {};
    const rawErrors = ['E1 complete', 'E2 complete'];
    const originalCode = 'FUNCTION_BLOCK "FB_Motor"\nBEGIN\n #Missing := TRUE;\nEND_FUNCTION_BLOCK';
    const repairedCode = 'FUNCTION_BLOCK "FB_Motor"\nBEGIN\n #Start := TRUE;\nEND_FUNCTION_BLOCK';
    const router = createTiaRoutes(createDeps({
        enqueueTiaOp: async fn => fn(),
        getMcpClient: () => ({
            callTool: async (name, args) => {
                if (name === 'GetPlcTagTables') return { content: [{ type: 'text', text: JSON.stringify({ items: ['TASK014_Acceptance_IO'] }) }] };
                assert.equal(name, 'ExportPlcTagTable');
                fs.writeFileSync(args.exportPath, TAG_FIXTURE, 'utf8');
                return { content: [{ type: 'text', text: JSON.stringify({ ExportPath: args.exportPath }) }] };
            },
        }),
        getCurrentModel: (userId, models) => {
            captured.modelUser = userId;
            captured.models = models;
            return models[0];
        },
        llmStream: async options => {
            captured.llm = options;
            const output = `修复结果\n\`\`\`scl\n${repairedCode}\n\`\`\``;
            options.onDelta(output);
            return output;
        },
    }));

    const response = await requestJson(router, 'POST', '/repair', {
        code: originalCode,
        diagnosis: [{ type: 'tag-not-defined', message: rawErrors[0] }],
        rawErrors,
        repairRound: 0,
        tokenUsed: 300,
        previousRawErrors: ['old'],
    });

    assert.equal(response.status, 200);
    assert.equal(response.json.success, true);
    assert.equal(response.json.code, repairedCode);
    assert.equal(response.json.repairRound, 1);
    assert.ok(response.json.tokenUsed > 300);
    assert.equal(captured.modelUser, 7);
    assert.equal(captured.llm.modelId, 'fake/model');
    const prompt = captured.llm.messages.map(message => message.content).join('\n');
    assert.match(prompt, /#Missing := TRUE/);
    assert.match(prompt, /E1 complete/);
    assert.match(prompt, /E2 complete/);
    assert.match(prompt, /tag-not-defined/);
    assert.match(prompt, /"StartButton"/);
});

test('repair prompt explicitly reports tag-table read failure instead of presenting fake empty data', async () => {
    let prompt = '';
    const router = createTiaRoutes(createDeps({
        enqueueTiaOp: async fn => fn(),
        getMcpClient: () => ({
            callTool: async name => {
                if (name === 'GetPlcTagTables') return { content: [{ type: 'text', text: JSON.stringify({ items: ['Broken'] }) }] };
                throw new Error('Openness export failed');
            },
        }),
        llmStream: async options => {
            prompt = options.messages.map(message => message.content).join('\n');
            return '```scl\nFUNCTION_BLOCK "FB_Motor"\nBEGIN\nEND_FUNCTION_BLOCK\n```';
        },
    }));

    const response = await requestJson(router, 'POST', '/repair', {
        code: 'FUNCTION_BLOCK "FB_Motor"\nBEGIN\nEND_FUNCTION_BLOCK',
        diagnosis: [{ type: 'tag-not-defined' }],
        rawErrors: ['Tag Missing not defined'],
        repairRound: 0,
        tokenUsed: 0,
    });

    assert.equal(response.status, 200);
    assert.equal(response.json.success, true);
    assert.match(prompt, /变量表读取失败：.*Openness export failed/);
    assert.doesNotMatch(prompt, /【PLC 变量表】\s*\{\}/);
});

test('repair stops before calling the model at either configured ceiling and returns code plus every error', async () => {
    let llmCalls = 0;
    const deps = createDeps({
        llmStream: async () => { llmCalls += 1; return 'must not run'; },
    });
    deps.db.prepare(`
        INSERT INTO user_settings (user_id, tia_auto_repair, tia_repair_max_tokens, tia_repair_max_rounds, tia_repair_skip_confirm)
        VALUES (7, 1, 900, 2, 0)
    `).run();
    const router = createTiaRoutes(deps);
    const body = {
        code: 'LAST_COMPLETE_CODE',
        diagnosis: [],
        rawErrors: ['FULL ERROR 1', 'FULL ERROR 2'],
        previousRawErrors: ['older'],
    };

    const tokenStop = await requestJson(router, 'POST', '/repair', { ...body, repairRound: 1, tokenUsed: 900 });
    assert.equal(tokenStop.json.stopped, true);
    assert.equal(tokenStop.json.stopReason, 'token-limit');
    assert.equal(tokenStop.json.lastCode, body.code);
    assert.deepEqual(tokenStop.json.rawErrors, body.rawErrors);

    const roundStop = await requestJson(router, 'POST', '/repair', { ...body, repairRound: 2, tokenUsed: 10 });
    assert.equal(roundStop.json.stopped, true);
    assert.equal(roundStop.json.stopReason, 'round-limit');
    assert.equal(roundStop.json.lastCode, body.code);
    assert.deepEqual(roundStop.json.rawErrors, body.rawErrors);
    assert.equal(llmCalls, 0);
});

test('a confirmed repair import records its repair round in write history', async () => {
    const history = [];
    const router = createTiaRoutes(createDeps({
        preflightImport: async () => ({
            ok: true,
            blockName: 'FB_New',
            blockType: 'FB',
            language: 'scl',
            nameTaken: false,
            existingCount: 0,
        }),
        importToTia: async () => ({ ok: true, blockName: 'FB_New', blockType: 'FB', language: 'scl' }),
        recordWriteHistory: (userId, info) => history.push([userId, info]),
    }));
    const code = 'FUNCTION_BLOCK "FB_New"\nBEGIN\nEND_FUNCTION_BLOCK';

    const pre = await requestJson(router, 'POST', '/preflight', { xml: code, lang: 'scl', repairRound: 2 });
    const imported = await requestJson(router, 'POST', '/import', {
        xml: code,
        confirmed: true,
        overwrite: false,
        confirmationToken: pre.json.confirmationToken,
    });

    assert.equal(imported.json.success, true);
    assert.equal(history[0][1].kind, 'repair-round-2');
});

test('new-block rollback delete requires preflight confirmation and runs through the TIA queue', async () => {
    const events = [];
    const router = createTiaRoutes(createDeps({
        enqueueTiaOp: async (fn, options) => {
            events.push(['queue', options]);
            return fn();
        },
        getMcpClient: () => ({
            callTool: async (name, args) => {
                events.push(['tool', name, args]);
                if (name === 'GetSoftwareTree') {
                    return { content: [{ type: 'text', text: JSON.stringify({
                        tree: [{ name: 'Program blocks', children: [{ name: 'FB_New', path: 'Program blocks/FB_New' }] }],
                    }) }] };
                }
                if (name === 'DeleteBlock') {
                    return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, blockName: args.blockName }) }] };
                }
                throw new Error('unexpected tool ' + name);
            },
        }),
    }));

    const preflight = await requestJson(router, 'POST', '/rollback/delete-preflight', {
        softwarePath: 'PLC_1',
        blockName: 'FB_New',
    });
    assert.equal(preflight.status, 200);
    assert.equal(preflight.json.success, true);
    assert.equal(preflight.json.blockPath, 'Program blocks/FB_New');
    assert.equal(typeof preflight.json.confirmationToken, 'string');

    const rejected = await requestJson(router, 'POST', '/rollback/delete', {
        softwarePath: 'PLC_1',
        blockName: 'FB_New',
        confirmationToken: preflight.json.confirmationToken,
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.json.message, /确认/);
    assert.equal(events.filter(event => event[1] === 'DeleteBlock').length, 0);

    const confirmedPreflight = await requestJson(router, 'POST', '/rollback/delete-preflight', {
        softwarePath: 'PLC_1',
        blockName: 'FB_New',
    });
    const deleted = await requestJson(router, 'POST', '/rollback/delete', {
        softwarePath: 'PLC_1',
        blockName: 'FB_New',
        confirmed: true,
        confirmationToken: confirmedPreflight.json.confirmationToken,
    });

    assert.equal(deleted.status, 200);
    assert.equal(deleted.json.success, true);
    assert.equal(deleted.json.deleted, true);
    const deleteTool = events.find(event => event[0] === 'tool' && event[1] === 'DeleteBlock');
    assert.deepEqual(deleteTool.slice(1), ['DeleteBlock', { softwarePath: 'PLC_1', blockName: 'FB_New' }]);
    assert.ok(events.some(event => event[0] === 'queue' && /删除新建块 FB_New/.test(event[1].label)));
});

test('new-block rollback delete rejects an invalid or mismatched confirmation token', async () => {
    let deleteCalls = 0;
    const router = createTiaRoutes(createDeps({
        consumeTiaConfirmation: () => null,
        getMcpClient: () => ({
            callTool: async name => {
                if (name === 'DeleteBlock') deleteCalls += 1;
                return { content: [{ type: 'text', text: '{}' }] };
            },
        }),
    }));

    const response = await requestJson(router, 'POST', '/rollback/delete', {
        softwarePath: 'PLC_1',
        blockName: 'FB_Other',
        confirmed: true,
        confirmationToken: 'wrong-token',
    });

    assert.equal(response.status, 409);
    assert.match(response.json.message, /失效|不匹配/);
    assert.equal(deleteCalls, 0);
});
