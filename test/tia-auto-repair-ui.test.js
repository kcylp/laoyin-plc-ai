const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function createElement(tagName = 'div') {
    const listeners = new Map();
    const element = {
        tagName: String(tagName).toUpperCase(),
        className: '',
        textContent: '',
        children: [],
        appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
        removeChild(child) { this.children = this.children.filter(item => item !== child); },
        addEventListener(type, handler) { listeners.set(type, handler); },
        async click() { const handler = listeners.get('click'); if (handler) await handler(); },
        remove() {},
        select() {},
        setAttribute(name, value) { this[name] = value; },
    };
    element.classList = {
        contains(name) { return element.className.split(/\s+/).includes(name); },
        add(name) { if (!this.contains(name)) element.className = `${element.className} ${name}`.trim(); },
        remove(name) { element.className = element.className.split(/\s+/).filter(item => item && item !== name).join(' '); },
    };
    return element;
}

function jsonResponse(data) {
    return { ok: true, status: 200, json: async () => data };
}

function loadTiaActionsHarness(options = {}) {
    const outputs = [];
    const confirmations = [];
    const preflightBodies = [];
    const importBodies = [];
    const compileBodies = [];
    const repairBodies = [];
    const deletePreflightBodies = [];
    const deleteBodies = [];
    const events = [];
    const settings = {
        autoRepair: true,
        maxTokens: 100000,
        maxRepairRounds: 5,
        skipRepairConfirmations: false,
        ...(options.settings || {}),
    };
    const storage = new Map(Object.entries({ token: 'token-1', plcSeries: 's1200' }));
    const codeBlock = {
        nextElementSibling: null,
        insertAdjacentElement(position, element) { this.nextElementSibling = element; },
    };
    const document = {
        body: createElement('body'),
        createElement,
        execCommand() { return true; },
    };
    function makeButton(code) {
        return {
        disabled: false,
        textContent: '发送至博途',
        getAttribute(name) {
            return name === 'data-code'
                ? code
                : '';
        },
        closest(selector) {
            if (selector === '.code-block') return codeBlock;
            if ((selector === '.assistant-message' || selector === '.message-content') && pipelineButtons.length) {
                return { querySelectorAll: () => pipelineButtons };
            }
            return null;
        },
    };
    }
    const defaultCode = options.code || 'FUNCTION_BLOCK "FB_Motor"\nBEGIN\nEND_FUNCTION_BLOCK';
    const pipelineButtons = (options.pipelineCodes || []).map(makeButton);
    const btn = pipelineButtons[0] || makeButton(defaultCode);
    let preflightCount = 0;
    let importCount = 0;
    let compileCount = 0;
    let repairCount = 0;
    const fetcher = async (url, requestOptions = {}) => {
        if (url === '/api/tia/compile-loop/settings') return jsonResponse({ success: true, settings });
        if (url === '/api/tia/preflight') {
            const request = JSON.parse(requestOptions.body || '{}');
            preflightBodies.push(request);
            events.push(`preflight:${blockNameFromTestCode(request.xml)}`);
            preflightCount += 1;
            const configured = (options.preflightResults || [])[preflightCount - 1];
            if (configured) return jsonResponse(configured);
            const blockName = blockNameFromTestCode(request.xml);
            return jsonResponse({
                success: true,
                blockName,
                blockType: 'FB',
                language: 'scl',
                existingCount: 0,
                confirmationToken: `confirm-${preflightCount}`,
            });
        }
        if (url === '/api/tia/import') {
            const request = JSON.parse(requestOptions.body || '{}');
            importBodies.push(request);
            events.push(`import:${blockNameFromTestCode(request.xml)}`);
            const result = (options.importResults || [])[importCount]
                || { success: true, stage: 'done', errorCount: 0, warningCount: 0, imported: ['FB_Motor'] };
            importCount += 1;
            return jsonResponse(result);
        }
        if (url === '/api/tia/compile') {
            const request = JSON.parse(requestOptions.body || '{}');
            compileBodies.push(request);
            events.push(`compile:${request.blockName}`);
            const result = (options.compileResults || [])[compileCount]
                || { success: true, errorCount: 0, warningCount: 0, rawErrors: [], diagnosis: [] };
            compileCount += 1;
            return jsonResponse(result);
        }
        if (url === '/api/tia/repair') {
            repairBodies.push(JSON.parse(requestOptions.body || '{}'));
            const result = (options.repairResults || [])[repairCount]
                || { success: false, stopped: true, stopReason: 'repair-failed', message: 'repair result missing' };
            repairCount += 1;
            return jsonResponse(result);
        }
        if (url === '/api/tia/rollback/delete-preflight') {
            const request = JSON.parse(requestOptions.body || '{}');
            deletePreflightBodies.push(request);
            events.push(`delete-preflight:${request.blockName}`);
            return jsonResponse({
                success: true,
                blockName: request.blockName,
                blockPath: `PLC_1/Program blocks/${request.blockName}` ,
                confirmationToken: `delete-${request.blockName}` ,
            });
        }
        if (url === '/api/tia/rollback/delete') {
            const request = JSON.parse(requestOptions.body || '{}');
            deleteBodies.push(request);
            events.push(`delete:${request.blockName}`);
            return jsonResponse({ success: true, deleted: request.blockName });
        }
        throw new Error('unexpected fetch: ' + url);
    };
    let confirmationCount = 0;
    const context = {
        console,
        setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 1; },
        TextDecoder,
        Blob: function Blob() {},
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
        navigator: { clipboard: { writeText: async () => {} } },
        localStorage: {
            getItem(key) { return storage.has(key) ? storage.get(key) : null; },
            setItem(key, value) { storage.set(key, String(value)); },
            removeItem(key) { storage.delete(key); },
        },
        document,
        fetch: fetcher,
        identifyCodeType: () => ({ lang: 'scl' }),
        confirmDialog: async (dialogOptions) => {
            confirmations.push(dialogOptions);
            const decision = (options.confirmations || [])[confirmationCount];
            confirmationCount += 1;
            return decision === undefined ? true : decision;
        },
        outputPanel: { push(row) { outputs.push(row); } },
        window: {
            plcAssistant: {
                series: 's1200',
                lang: 'scl',
                modelId: 'db1/model-a',
                refreshRealTree() {},
                inspectorShow() {},
            },
            TiaConfirmation: {
                buildTiaConfirmation: pre => ({
                    blockName: pre.blockName,
                    language: pre.language,
                    existingCount: pre.existingCount,
                }),
            },
            TiaImportState: {
                createTiaImportState: () => {
                    let pending = null;
                    return {
                        set(payload) { pending = payload; },
                        clear() { pending = null; },
                        async confirm(fetcherArg) {
                            if (!pending) return null;
                            const payload = pending;
                            pending = null;
                            const response = await fetcherArg('/api/tia/import', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + payload.token },
                                body: JSON.stringify({
                                    xml: payload.xml,
                                    confirmed: true,
                                    overwrite: !!payload.overwrite,
                                    confirmationToken: payload.confirmationToken,
                                }),
                            });
                            return response.json();
                        },
                    };
                },
            },
        },
    };
    context.globalThis = context;
    vm.createContext(context);
    const source = fs.readFileSync(path.join(root, 'web', 'tia-actions.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '')
        .replace(/export \{[\s\S]*?\};?\s*$/m, 'globalThis.__tia = { sendToTia, startTiaImport };');
    vm.runInContext(source, context);
    return {
        ...context.__tia,
        btn,
        outputs,
        confirmations,
        preflightBodies,
        importBodies,
        compileBodies,
        repairBodies,
        deletePreflightBodies,
        deleteBodies,
        events,
        pipelineButtons,
        codeBlock,
    };
}

function blockNameFromTestCode(code) {
    const match = String(code || '').match(/FUNCTION_BLOCK\s+"?([^"\s]+)/i);
    return match ? match[1] : 'FB_Motor';
}

const ERROR_ONE = 'Error Path=FB_Motor Line=18 BL_PARSE_111B: Tag "Missing" not defined';
const ERROR_TWO = 'Error Path=FB_Motor Line=19 BL_PARSE_111B: Tag "StillMissing" not defined';
const COMPILE_FAILURE = {
    success: true,
    errorCount: 1,
    warningCount: 0,
    rawErrors: [ERROR_ONE],
    diagnosis: [{ type: 'tag-not-defined', message: 'Tag "Missing" not defined', '修复建议': '补齐变量' }],
};
const REPAIRED_CODE = 'FUNCTION_BLOCK "FB_Motor"\nBEGIN\n    #Start := TRUE;\nEND_FUNCTION_BLOCK';

test('auto repair carries complete compiler diagnosis and confirms every write', async () => {
    const harness = loadTiaActionsHarness({
        compileResults: [COMPILE_FAILURE, { success: true, errorCount: 0, warningCount: 0, rawErrors: [], diagnosis: [] }],
        repairResults: [{ success: true, code: REPAIRED_CODE, repairRound: 1, tokenUsed: 480 }],
    });

    await harness.sendToTia(harness.btn);

    assert.equal(harness.repairBodies.length, 1);
    assert.deepEqual(harness.repairBodies[0].rawErrors, [ERROR_ONE]);
    assert.deepEqual(harness.repairBodies[0].diagnosis, COMPILE_FAILURE.diagnosis);
    assert.equal(harness.repairBodies[0].code.includes('FUNCTION_BLOCK'), true);
    assert.deepEqual(harness.preflightBodies.map(body => body.repairRound || 0), [0, 1]);
    assert.equal(harness.importBodies.length, 2);
    assert.equal(harness.compileBodies.length, 2);
    assert.deepEqual(harness.confirmations.map(item => item.title), ['写入博途', '自动修复第 1 轮']);
    assert.ok(harness.outputs.some(row => /第 1\/5 轮 · 480\/100000 token/.test(row.body || '')));
    assert.ok(harness.outputs.some(row => /编译通过/.test(row.body || '')));
});

test('disabled auto repair preserves compiler errors without calling repair', async () => {
    const harness = loadTiaActionsHarness({
        settings: { autoRepair: false },
        compileResults: [COMPILE_FAILURE],
    });

    await harness.sendToTia(harness.btn);

    assert.equal(harness.repairBodies.length, 0);
    assert.equal(harness.importBodies.length, 1);
    const manual = harness.outputs.find(row => /自动修复已关闭/.test(row.body || ''));
    assert.ok(manual, 'expected manual-mode output');
    assert.match(manual.body, /Tag "Missing" not defined/);
});

test('token ceiling stops before another write and returns full code and errors', async () => {
    const currentCode = 'FUNCTION_BLOCK "FB_Motor"\nBEGIN\n    Missing := TRUE;\nEND_FUNCTION_BLOCK';
    const harness = loadTiaActionsHarness({
        code: currentCode,
        settings: { maxTokens: 1 },
        compileResults: [COMPILE_FAILURE],
        repairResults: [{
            success: false,
            stopped: true,
            stopReason: 'token-limit',
            message: '已达到 1 token 上限',
            lastCode: currentCode,
            rawErrors: [ERROR_ONE, ERROR_TWO],
            repairRound: 0,
            tokenUsed: 24,
        }],
    });

    await harness.sendToTia(harness.btn);

    assert.equal(harness.repairBodies.length, 1);
    assert.equal(harness.importBodies.length, 1);
    assert.equal(harness.preflightBodies.length, 1);
    const stop = harness.outputs.find(row => row.title === '自动修复闭环已停止');
    assert.ok(stop, 'expected token-limit stop output');
    assert.match(stop.body, /FUNCTION_BLOCK "FB_Motor"/);
    assert.match(stop.body, /Tag "Missing" not defined/);
    assert.match(stop.body, /Tag "StillMissing" not defined/);
});

test('repair round ceiling is configurable and returns all errors after the last round', async () => {
    const harness = loadTiaActionsHarness({
        settings: { maxRepairRounds: 1 },
        compileResults: [COMPILE_FAILURE, { ...COMPILE_FAILURE, rawErrors: [ERROR_ONE, ERROR_TWO] }],
        repairResults: [
            { success: true, code: REPAIRED_CODE, repairRound: 1, tokenUsed: 480 },
            {
                success: false,
                stopped: true,
                stopReason: 'round-limit',
                message: '已达到 1 轮自动修复上限',
                lastCode: REPAIRED_CODE,
                rawErrors: [ERROR_ONE, ERROR_TWO],
                repairRound: 1,
                tokenUsed: 560,
            },
        ],
    });

    await harness.sendToTia(harness.btn);

    assert.equal(harness.repairBodies.length, 2);
    assert.equal(harness.importBodies.length, 2);
    const stop = harness.outputs.find(row => row.title === '自动修复闭环已停止');
    assert.ok(stop, 'expected round-limit stop output');
    assert.match(stop.body, /已达到 1 轮自动修复上限/);
    assert.match(stop.body, /Tag "Missing" not defined/);
    assert.match(stop.body, /Tag "StillMissing" not defined/);
});

test('cancelling a repair confirmation stops before import and recompilation', async () => {
    const harness = loadTiaActionsHarness({
        confirmations: [true, false],
        compileResults: [COMPILE_FAILURE],
        repairResults: [{ success: true, code: REPAIRED_CODE, repairRound: 1, tokenUsed: 480 }],
    });

    await harness.sendToTia(harness.btn);

    assert.equal(harness.preflightBodies.length, 2);
    assert.equal(harness.confirmations.length, 2);
    assert.equal(harness.importBodies.length, 1);
    assert.equal(harness.compileBodies.length, 1);
    assert.match(harness.codeBlock.nextElementSibling.textContent, /已取消，闭环停止/);
});

test('pipeline failure rolls back completed blocks in reverse order through protected APIs', async () => {
    const oldOne = 'FUNCTION_BLOCK "FB_One"\nBEGIN\n    #Old := TRUE;\nEND_FUNCTION_BLOCK';
    const harness = loadTiaActionsHarness({
        pipelineCodes: [
            'FUNCTION_BLOCK "FB_One"\nBEGIN\nEND_FUNCTION_BLOCK',
            'FUNCTION_BLOCK "FB_Two"\nBEGIN\nEND_FUNCTION_BLOCK',
            'FUNCTION_BLOCK "FB_Three"\nBEGIN\nEND_FUNCTION_BLOCK',
        ],
        settings: { autoRepair: false },
        preflightResults: [
            { success: true, blockName: 'FB_One', blockType: 'FB', language: 'scl', existingCount: 1, previousContent: oldOne, confirmationToken: 'write-1' },
            { success: true, blockName: 'FB_Two', blockType: 'FB', language: 'scl', existingCount: 0, confirmationToken: 'write-2' },
            { success: true, blockName: 'FB_Three', blockType: 'FB', language: 'scl', existingCount: 0, confirmationToken: 'write-3' },
            { success: true, blockName: 'FB_One', blockType: 'FB', language: 'scl', existingCount: 1, confirmationToken: 'rollback-1' },
        ],
        compileResults: [
            { success: true, errorCount: 0, warningCount: 0, rawErrors: [], diagnosis: [] },
            { success: true, errorCount: 0, warningCount: 0, rawErrors: [], diagnosis: [] },
            COMPILE_FAILURE,
        ],
    });

    await harness.sendToTia(harness.btn);

    assert.deepEqual(harness.deletePreflightBodies, [{ softwarePath: 'PLC_1', blockName: 'FB_Two' }]);
    assert.equal(harness.deleteBodies[0].confirmed, true);
    assert.equal(harness.deleteBodies[0].confirmationToken, 'delete-FB_Two');
    assert.deepEqual(
        harness.events.slice(-4),
        ['delete-preflight:FB_Two', 'delete:FB_Two', 'preflight:FB_One', 'import:FB_One'],
    );
    assert.ok(harness.outputs.some(row => row.title === '整体回滚完成'));
});

test('cancelling new-block deletion stops reverse rollback before older blocks', async () => {
    const oldOne = 'FUNCTION_BLOCK "FB_One"\nBEGIN\n    #Old := TRUE;\nEND_FUNCTION_BLOCK';
    const harness = loadTiaActionsHarness({
        pipelineCodes: [
            'FUNCTION_BLOCK "FB_One"\nBEGIN\nEND_FUNCTION_BLOCK',
            'FUNCTION_BLOCK "FB_Two"\nBEGIN\nEND_FUNCTION_BLOCK',
            'FUNCTION_BLOCK "FB_Three"\nBEGIN\nEND_FUNCTION_BLOCK',
        ],
        settings: { autoRepair: false },
        confirmations: [true, true, true, true, true, false],
        preflightResults: [
            { success: true, blockName: 'FB_One', blockType: 'FB', language: 'scl', existingCount: 1, previousContent: oldOne, confirmationToken: 'write-1' },
            { success: true, blockName: 'FB_Two', blockType: 'FB', language: 'scl', existingCount: 0, confirmationToken: 'write-2' },
            { success: true, blockName: 'FB_Three', blockType: 'FB', language: 'scl', existingCount: 0, confirmationToken: 'write-3' },
        ],
        compileResults: [
            { success: true, errorCount: 0, warningCount: 0, rawErrors: [], diagnosis: [] },
            { success: true, errorCount: 0, warningCount: 0, rawErrors: [], diagnosis: [] },
            COMPILE_FAILURE,
        ],
    });

    await harness.sendToTia(harness.btn);

    assert.equal(harness.deletePreflightBodies.length, 1);
    assert.equal(harness.deleteBodies.length, 0);
    assert.equal(harness.preflightBodies.length, 3, 'older overwritten block must not be touched after cancellation');
    assert.ok(harness.outputs.some(row => row.title === '整体回滚已停止'));
});
