const test = require('node:test');
const assert = require('node:assert/strict');

const {
    defaultLang,
    normalizeLang,
    availableLangs,
    getPromptKey,
    languageLabel
} = require('../plc-language');

test('S7-1200 and S7-1500 default to SCL while S7-200 SMART defaults to STL', () => {
    assert.equal(defaultLang('s1200'), 'scl');
    assert.equal(defaultLang('s1500'), 'scl');
    assert.equal(defaultLang('s200smart'), 'stl');
});

test('S7-200 SMART exposes only LAD and STL', () => {
    assert.deepEqual(availableLangs('s200smart'), ['lad', 'stl']);
    assert.equal(normalizeLang('s200smart', 'lad'), 'lad');
    assert.equal(normalizeLang('s200smart', 'scl'), 'stl');
});

test('S7-1200 and S7-1500 support GRAPH while unknown values fall back', () => {
    assert.equal(normalizeLang('s1200', 'lad'), 'lad');
    assert.equal(normalizeLang('s1200', 'bogus'), 'scl');
    assert.equal(normalizeLang('s1200', 'GRAPH'), 'graph');
    assert.equal(normalizeLang('s1500', 'graph'), 'graph');
    assert.ok(availableLangs('s1200').includes('graph'));
    assert.ok(!availableLangs('s200smart').includes('graph'));
});

test('prompt keys and display labels use normalized language values', () => {
    assert.equal(getPromptKey('s1500', 'fbd'), 's1500_fbd');
    assert.equal(getPromptKey('s200smart', 'scl'), 's200smart_stl');
    assert.equal(languageLabel('lad'), 'LAD 梯形图');
});
