const test = require('node:test');
const assert = require('node:assert/strict');

const { preflightImport, normalizeImportLanguage } = require('../engineer-yin-bridge');

test('normalizes displayed preflight language without trusting engine output', () => {
    assert.equal(normalizeImportLanguage('SCL'), 'scl');
    assert.equal(normalizeImportLanguage('unknown'), 'lad');
});

test('preflight returns the user-selected language and stays read-only', async () => {
    const calls = [];
    const runner = async (mode, xml, overwrite) => {
        calls.push({ mode, xml, overwrite });
        return { ok: true, language: 'engine-inferred-lad', blockName: 'FB_Test' };
    };

    const result = await preflightImport('<Document />', 'scl', runner);

    assert.deepEqual(calls, [{ mode: 'preflight', xml: '<Document />', overwrite: false }]);
    assert.equal(result.language, 'scl');
    assert.equal(result.blockName, 'FB_Test');
});
