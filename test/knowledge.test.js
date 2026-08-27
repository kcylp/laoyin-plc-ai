const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createKnowledgeService, parseFrontmatter, selectWorkflow } = require('../lib/knowledge');

const service = createKnowledgeService();

test('knowledge search scores ladder blocks by PLC wording relevance', () => {
    const hits = service.searchKnowledge('两台泵轮换运行，运行 30 分钟后自动切换，故障时备用泵接管', { limit: 3 });

    assert.ok(hits.length >= 1);
    assert.equal(hits[0].id, 'multi-pump-rotate');
    assert.equal(hits[0].title, '多台设备轮换');
    assert.ok(hits[0].score > 0);
    assert.ok(hits[0].matchedTerms.includes('轮换') || hits[0].matchedTerms.includes('泵'));
});

test('knowledge prompt filters pending safety sections but browser docs retain review markers', () => {
    const prompt = service.buildKnowledgePrompt({
        message: '电机起保停，停止按钮按常闭接线',
        projectContextStatus: { connected: false, blockCount: 0 },
        limit: 2,
        maxPromptChars: 6000,
    });

    assert.match(prompt.prompt, /【知识库】/);
    assert.match(prompt.prompt, /参考：《电机起保停（自锁）》/);
    assert.match(prompt.prompt, /工作流：新建工程/);
    assert.doesNotMatch(prompt.prompt, /⚠️【待老殷审】/);
    assert.doesNotMatch(prompt.prompt, /## 常见坑/);
    assert.doesNotMatch(prompt.prompt, /## 上机前必须确认/);
    assert.equal(prompt.status.workflow.id, 'A');
    assert.equal(prompt.status.pendingSectionsFiltered > 0, true);

    const doc = service.readKnowledgeDoc('start-stop');
    assert.equal(doc.meta.review_status, 'pending');
    assert.equal(doc.review.status, 'pending');
    assert.match(doc.content, /⚠️【待老殷审】/);
    assert.match(doc.warning, /未经领域专家审定/);
});

test('CRLF frontmatter is parsed before knowledge documents enter prompts', () => {
    const parsed = parseFrontmatter('---\r\nid: crlf-block\r\nreview_status: pending\r\n---\r\n正文');
    assert.equal(parsed.meta.id, 'crlf-block');
    assert.equal(parsed.meta.review_status, 'pending');
    assert.equal(parsed.body, '正文');

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-crlf-'));
    try {
        const knowledgeDir = path.join(tempRoot, 'knowledge');
        fs.mkdirSync(path.join(knowledgeDir, 'blocks'), { recursive: true });
        fs.mkdirSync(path.join(knowledgeDir, 'workflows'), { recursive: true });
        fs.writeFileSync(path.join(knowledgeDir, 'index.json'), JSON.stringify([{ id: 'crlf-block', title: 'CRLF 测试块', category: '基础逻辑', keywords: ['CRLF'], file: 'blocks/crlf.md', review_status: 'pending' }]), 'utf8');
        fs.writeFileSync(path.join(knowledgeDir, 'blocks', 'crlf.md'), [
            '---',
            'id: crlf-block',
            'title: CRLF 测试块',
            'review_status: pending',
            '---',
            '# CRLF 测试块',
            '可注入正文。',
            '### ⚠️【待老殷审】常见坑',
            '未审安全文字。',
            '### 正常说明',
            '继续保留。'
        ].join('\r\n'), 'utf8');
        fs.writeFileSync(path.join(knowledgeDir, 'workflows', 'A-新建工程.md'), [
            '---',
            'id: workflow-a',
            '---',
            '# 工作流 A',
            '第一步。'
        ].join('\r\n'), 'utf8');

        const crlfService = createKnowledgeService({ rootDir: tempRoot });
        const prompt = crlfService.buildKnowledgePrompt({
            message: 'CRLF 测试',
            projectContextStatus: { connected: false, blockCount: 0 },
            maxPromptChars: 4000,
        });

        assert.equal(prompt.docs[0].meta.review_status, 'pending');
        assert.doesNotMatch(prompt.prompt, /^---/m);
        assert.doesNotMatch(prompt.prompt, /review_status:/);
        assert.doesNotMatch(prompt.prompt, /未审安全文字/);
        assert.match(prompt.prompt, /可注入正文/);
        assert.match(prompt.prompt, /第一步/);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('workflow selection separates new project, existing project, reading and compile-error flows', () => {
    assert.equal(selectWorkflow({ connected: false }, '帮我从零新建一个起保停程序').id, 'A');
    assert.equal(selectWorkflow({ connected: true, blockCount: 0 }, '新项目写一个起保停').id, 'A');
    assert.equal(selectWorkflow({ connected: true, blockCount: 5 }, '给现有程序加两台泵轮换').id, 'B');
    assert.equal(selectWorkflow({ connected: true, blockCount: 5 }, '帮我读懂 OB1 里这段程序').id, 'C');
    assert.equal(selectWorkflow({ connected: true, blockCount: 5 }, '编译报错 Missing identifier attribute 怎么排查').id, 'D');
});

test('scenario cards are generated from knowledge index as the single source', () => {
    const scenarios = service.getScenarioCards(12);

    assert.equal(scenarios.length, 12);
    assert.deepEqual(scenarios.slice(0, 4).map(item => item.title), [
        '电机起保停（自锁）',
        '起保停（置位复位版）',
        '正反转互锁',
        '点动与长动切换',
    ]);
    const rotate = scenarios.find(item => item.id === 'multi-pump-rotate');
    assert.ok(rotate);
    assert.match(rotate.prompt, /轮换/);
    assert.doesNotMatch(rotate.prompt, /<[^>]+>/);
});

test('same PLC request receives stable workflow and knowledge references across repeated prompt builds', () => {
    const runs = Array.from({ length: 3 }, () => service.buildKnowledgePrompt({
        message: '给现有程序加两台泵轮换，30 分钟切一次，故障泵自动跳过',
        projectContextStatus: { connected: true, blockCount: 8, project: 'Demo' },
        limit: 3,
        maxPromptChars: 9000,
    }));

    const signatures = runs.map(run => ({
        workflow: run.status.workflow.id,
        refs: run.status.matches.map(item => item.id),
        promptHeader: run.prompt.split('\n').slice(0, 8),
    }));

    assert.deepEqual(signatures[1], signatures[0]);
    assert.deepEqual(signatures[2], signatures[0]);
    assert.equal(signatures[0].workflow, 'B');
    assert.equal(signatures[0].refs[0], 'multi-pump-rotate');
});

test('pending block safety sections must carry the human-review marker', () => {
    const blocksDir = path.join(__dirname, '..', 'knowledge', 'blocks');
    const failures = [];

    for (const file of fs.readdirSync(blocksDir).filter(name => name.endsWith('.md')).sort()) {
        const fullPath = path.join(blocksDir, file);
        const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
        const frontmatter = lines.slice(0, lines.indexOf('---', 1)).join('\n');
        const approved = /review_status:\s*["']?approved["']?/m.test(frontmatter);
        if (approved) continue;

        for (const [index, line] of lines.entries()) {
            if (/^#{1,6}\s+.*(常见坑|上机前必须确认)/.test(line) && !line.includes('⚠️【待老殷审】')) {
                failures.push(`${file}:${index + 1}:${line}`);
            }
        }
    }

    assert.deepEqual(failures, []);
});
