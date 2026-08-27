'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_PATH = path.join(
    __dirname,
    '..',
    'engine',
    'tia-mcp',
    'tools',
    'tiaportal-mcp',
    'src',
    'TiaMcpServer',
    'Siemens',
    'Portal.Software.cs',
);

test('GetPlcTagTables enumerates from the tag-table root instead of nesting an extracted collection', () => {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const method = source.match(/public List<string>\? GetPlcTagTables\(string softwarePath\)([\s\S]*?)\n        public bool ExportPlcTagTable/);

    assert.ok(method, 'GetPlcTagTables source method should exist');
    assert.match(method[1], /TryGetPropertyValue\(plc, "TagTableGroup", "TagTableFolder"\) \?\? plc/);
    assert.doesNotMatch(method[1], /TryGetPropertyValue\(plc, "TagTables"\) \?\?/);
    assert.match(method[1], /TryListNamesFromCollection\(tablesRoot, new\[\] \{ "TagTables" \}, "TagTables"\)/);
});
