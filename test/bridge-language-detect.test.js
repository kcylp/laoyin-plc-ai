const test = require('node:test');
const assert = require('node:assert/strict');

const { detectLangFromXml, normalizeImportLanguage } = require('../engineer-yin-bridge');

test('detectLangFromXml reads ProgrammingLanguage as backend fallback', () => {
    assert.equal(detectLangFromXml('<Document><ProgrammingLanguage>SCL</ProgrammingLanguage></Document>'), 'scl');
    assert.equal(detectLangFromXml('<Document><ProgrammingLanguage>LAD</ProgrammingLanguage></Document>'), 'lad');
    assert.equal(detectLangFromXml('<Document><ProgrammingLanguage>FBD</ProgrammingLanguage></Document>'), 'fbd');
    assert.equal(detectLangFromXml('<Document><ProgrammingLanguage>STL</ProgrammingLanguage></Document>'), 'stl');
    assert.equal(detectLangFromXml('<Document><ProgrammingLanguage>Graph</ProgrammingLanguage></Document>'), 'graph');
    assert.equal(detectLangFromXml('<Document><sw:ProgrammingLanguage schemaVersion="1">FBD</sw:ProgrammingLanguage></Document>'), 'fbd');
    assert.equal(detectLangFromXml('<Document/>'), null);
    assert.equal(detectLangFromXml('<Document><ProgrammingLanguage>Weird</ProgrammingLanguage></Document>'), null);
    assert.equal(detectLangFromXml(''), null);
});

test('normalizeImportLanguage stays strict and falls back to lad', () => {
    assert.equal(normalizeImportLanguage('SCL'), 'scl');
    assert.equal(normalizeImportLanguage('unknown'), 'lad');
    assert.equal(normalizeImportLanguage(undefined), 'lad');
});
