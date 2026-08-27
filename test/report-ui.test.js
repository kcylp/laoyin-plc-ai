const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('workbench exposes a complete delivery report panel without changing the existing app module', () => {
    const html = read('index.html');
    const source = read('web/report-panel.js');

    assert.match(html, /id="btnDeliveryReport"/);
    assert.match(html, /id="reportModal"/);
    assert.match(html, /id="reportOverview"/);
    assert.match(html, /id="reportOperationLogic"/);
    assert.match(html, /id="reportPreview"/);
    assert.match(html, /id="reportDownloadMarkdown"/);
    assert.match(html, /id="reportDownloadWord"/);
    assert.match(html, /id="reportPrintPdf"/);
    assert.match(html, /<script type="module" src="web\/report-panel\.js"><\/script>/);
    assert.match(source, /\/api\/report\/generate/);
    assert.match(source, /\/api\/report\/export/);
    assert.match(source, /MutationObserver/);
    assert.match(source, /编译通过|错误 0/);
    assert.match(source, /Blob/);
    assert.match(source, /\.print\(\)/);
    assert.match(source, /base64/);
    assert.match(source, /请先连接|博途/);
});

test('delivery report modal keeps its header and actions visible on desktop and narrow screens', () => {
    const html = read('index.html');

    assert.match(html, /\.report-modal\{[^}]*display:grid;[^}]*grid-template-rows:auto minmax\(0,1fr\) auto;[^}]*overflow:hidden/);
    assert.match(html, /@media\(max-width:900px\)\{[^}]*\.report-modal \.tia-modal-foot\{flex-wrap:wrap/);
});

test('settings page loads and saves company information for report headers and footers', () => {
    const html = read('settings.html');

    for (const id of ['reportCompanyName', 'reportContact', 'reportProjectPrefix', 'reportLogoFile', 'saveReportSettings']) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(html, /api\('\/api\/report\/settings'/);
    assert.match(html, /companyName/);
    assert.match(html, /projectPrefix/);
    assert.match(html, /logoData/);
    assert.match(html, /FileReader/);
});

test('default report template is an editable ordered section configuration', () => {
    const template = JSON.parse(read('templates/report/default.json'));

    assert.equal(template.title, 'PLC 程序设计交付文档');
    assert.ok(Array.isArray(template.sections));
    assert.deepEqual(template.sections.map(section => section.id), [
        'overview', 'program', 'io', 'operation', 'compile', 'safety', 'history', 'appendix',
    ]);
});
