const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildReportModel,
    buildReportMarkdown,
    renderReportHtml,
    collectKnowledgeConfirmations,
} = require('../lib/report-builder');

const tree = [
    'Project',
    '    ├── PLC_1',
    '    │   ├── Program blocks',
    '    │   │   ├── Main [OB1, LAD]',
    '    │   │   ├── Motion [FB3, SCL]',
    '    │   │   └── Data [DB10, ]',
].join('\n');

const tables = [{
    name: 'GlobalTags',
    tags: [
        { name: 'Start', dataType: 'Bool', logicalAddress: '%I0.0', comment: '启动按钮' },
        { name: 'Motor', dataType: 'Bool', logicalAddress: '%Q0.0', comment: '电机输出' },
        { name: 'Speed', dataType: 'Real', logicalAddress: '%MD10', comment: '速度设定' },
    ],
}];

test('buildReportModel assembles real program blocks and separates I/O tags from appendix', () => {
    const report = buildReportModel({
        project: { name: 'Demo Project', plcName: 'PLC_1', plcFamily: 'S7-1200', firmware: 'V4.7' },
        softwareTree: tree,
        tagTables: tables,
        history: [{ block_name: 'Motion', block_type: 'FB', overwrite: 1, created_at: '2026-08-27 10:00' }],
        compile: { success: true, messages: ['Compile succeeded: 0 errors, 0 warnings'] },
    });

    assert.deepEqual(report.programBlocks.map(block => [block.name, block.type, block.lang]), [
        ['Main', 'OB1', 'LAD'],
        ['Motion', 'FB3', 'SCL'],
        ['Data', 'DB10', ''],
    ]);
    assert.deepEqual(report.ioTags.map(tag => tag.logicalAddress), ['%I0.0', '%Q0.0']);
    assert.equal(report.allTags.length, 3);
    assert.equal(report.history[0].overwrite, true);
    assert.match(report.compile.summary, /0 errors/);
});

test('collectKnowledgeConfirmations matches used blocks and removes duplicate confirmations', () => {
    const confirmations = collectKnowledgeConfirmations({
        usedBlockIds: ['start-stop', 'star-delta'],
        knowledgeDocs: [
            { id: 'start-stop', title: '起保停', content: '### 上机前必须确认\n- 停止按钮接线现场确认\n- 急停回路现场确认' },
            { id: 'star-delta', title: '星三角', content: '### 上机前必须确认\n- 急停回路现场确认\n- 星三角硬件互锁确认' },
        ],
    });

    assert.deepEqual(confirmations, [
        '停止按钮接线现场确认',
        '急停回路现场确认',
        '星三角硬件互锁确认',
    ]);
});

test('rendered report always carries fixed safety warning and sanitizes secrets and paths', () => {
    const report = buildReportModel({
        project: { name: 'Secret Project', sourcePath: 'C:\\Users\\alice\\secret.ap21', company: 'Acme <PLC>' },
        softwareTree: tree,
        tagTables: tables,
        overview: 'API_KEY=sk-test-1234 located at C:\\Users\\alice\\secret.ap21',
        knowledgeConfirmations: ['现场确认停止按钮'],
    });
    const markdown = buildReportMarkdown(report);
    const html = renderReportHtml(report);

    assert.match(markdown, /⚠️ 编译 0 错误 ≠ 上机能跑/);
    assert.match(html, /上机前必须现场确认/);
    assert.doesNotMatch(markdown, /sk-test-1234|C:\\Users\\alice/);
    assert.match(markdown, /<credential-redacted>|<api-key-redacted>|<path>/);
});

test('renderReportHtml renders report tables as printable HTML tables', () => {
    const report = buildReportModel({
        project: { name: 'Table Project' },
        softwareTree: tree,
        tagTables: tables,
        history: [{ block_name: 'Main', block_type: 'OB', kind: 'write' }],
    });

    const html = renderReportHtml(report);

    assert.match(html, /<table>/);
    assert.match(html, /<th>块名<\/th>/);
    assert.match(html, /<td>Main<\/td>/);
    assert.match(html, /<td>%I0\.0<\/td>/);
    assert.doesNotMatch(html, /class="table-line"/);
    assert.match(html, /break-inside\s*:\s*avoid/);
});

test('buildReportMarkdown accepts a configurable section order and titles', () => {
    const report = buildReportModel({ project: { name: 'Template Project' }, softwareTree: tree, tagTables: tables });
    const markdown = buildReportMarkdown(report, {
        title: '客户交付书',
        documentNotice: '客户自定义说明',
        sections: [
            { id: 'io', title: '现场 I/O' },
            { id: 'overview', title: '方案摘要' },
            { id: 'safety', title: '投运确认' },
        ],
    });

    assert.match(markdown, /^# 客户交付书/);
    assert.match(markdown, /客户自定义说明/);
    assert.ok(markdown.indexOf('## 现场 I/O') < markdown.indexOf('## 方案摘要'));
    assert.ok(markdown.indexOf('## 方案摘要') < markdown.indexOf('## 投运确认'));
    assert.doesNotMatch(markdown, /## 修改履历/);
});

test('renderReportHtml includes only a validated image data URL as the company logo', () => {
    const valid = buildReportModel({ project: { name: 'Logo Project', logoData: 'data:image/png;base64,AAAA' } });
    const invalid = buildReportModel({ project: { name: 'Bad Logo', logoData: 'javascript:alert(1)' } });

    assert.match(renderReportHtml(valid), /<img[^>]+data:image\/png;base64,AAAA/);
    assert.doesNotMatch(renderReportHtml(invalid), /javascript:|<img/);
});
