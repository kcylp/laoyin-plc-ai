const test = require('node:test');
const assert = require('node:assert/strict');

const { createTiaImportState } = require('../tia-import-state');

test('closing a pending TIA modal does not call import', async () => {
    const state = createTiaImportState();
    const imports = [];
    state.set({ xml: '<Document />', overwrite: false });
    state.clear();

    const result = await state.confirm(async () => {
        imports.push('called');
    });

    assert.equal(result, null);
    assert.deepEqual(imports, []);
});

test('confirming sends exactly one import request with confirmed true', async () => {
    const state = createTiaImportState();
    const requests = [];
    state.set({ xml: '<Document />', overwrite: true, token: 'token-1', confirmationToken: 'confirm-1' });

    const first = await state.confirm(async (url, options) => {
        requests.push({ url, options });
        return { json: async () => ({ success: true }) };
    });
    const second = await state.confirm(async () => {
        requests.push({ url: 'unexpected' });
    });

    assert.deepEqual(first, { success: true });
    assert.equal(second, null);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/tia/import');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer token-1');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        xml: '<Document />',
        confirmed: true,
        overwrite: true,
        confirmationToken: 'confirm-1'
    });
});
