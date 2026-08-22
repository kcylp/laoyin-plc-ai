const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(file) {
    return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

function clientBundle() {
    return [
        'web/app.js',
        'web/chat.js',
        'web/confirm-dialog.js',
        'web/history.js',
        'web/inspector.js',
        'web/online.js',
        'web/output-panel.js',
        'web/statusbar.js',
        'web/tia-actions.js',
        'web/tree.js',
    ].map(read).join('\n');
}

test('C layout removes old drawers and routes work through output panel', () => {
    const html = read('index.html');
    const js = clientBundle();
    const panelsCss = read('web/css/panels.css');
    const dangerRule = panelsCss.match(/\.tia-btn\.is-danger\s*\{([^}]+)\}/);
    assert.doesNotMatch(html, /tiaOnlineDrawer|dlModal|odResultWrap|待写入队列/);
    assert.doesNotMatch(js, /tiaOnlineDrawer|dlModal|odResultWrap|showTiaModal|tiaModal|tmConfirm|tmResult|onlineDrawer/);
    assert.match(js, /outputPanel\.push/);
    assert.match(js, /inspectorShow\('write-result'/);
    assert.match(js, /inspectorShow\('live-values'/);
    assert.ok(dangerRule, 'danger button rule should exist');
    assert.match(dangerRule[1], /color:\s*var\(--tia-text-inv\)/);
    assert.match(dangerRule[1], /background:\s*var\(--tia-err\)/);
});

test('C confirmations use the unified confirm dialog for all high-risk actions', () => {
    const js = clientBundle();
    assert.doesNotMatch(js, /window\.confirm/);
    assert.match(js, /title: '写入博途'/);
    assert.match(js, /title: '回滚到版本/);
    assert.match(js, /title: '下载到 PLC'/);
    assert.match(js, /title: '正式建工程'/);
    assert.match(js, /危险工具调用/);
    assert.match(js, /requireCheck: '我已确认现场安全'/);
});

test('C inspector supports contextual panes with a system fallback', () => {
    const js = read('web/inspector.js');
    for (const type of ['system', 'block-logic', 'write-result', 'live-values', 'tag-table']) {
        assert.match(js, new RegExp(type));
    }
    assert.match(js, /返回系统状态/);
    assert.match(js, /data-export-s7dcl/);
    assert.ok(js.includes('/api/tia/mcp/export-s7dcl'));
    assert.match(js, /new Blob/);
});
