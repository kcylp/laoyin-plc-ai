const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'tia-actions.js'), 'utf8');

test('compile loop UI exposes persisted settings with approved defaults', () => {
    assert.match(source, /\/api\/tia\/compile-loop\/settings/);
    assert.match(source, /autoRepair:\s*false/);
    assert.match(source, /maxTokens:\s*100000/);
    assert.match(source, /maxRepairRounds:\s*5/);
    assert.match(source, /skipRepairConfirmations:\s*false/);
    assert.match(source, /type\s*=\s*['"]number['"]/);
});

test('overwrite confirmation presents interface changes and the complete line diff', () => {
    assert.match(source, /interfaceChanges/);
    assert.match(source, /diffLines/);
    assert.match(source, /接口变更/);
    assert.match(source, /逐行 diff/);
    assert.doesNotMatch(source, /diffLines[^\n]*\.slice\(/);
});

test('auto repair compiles, carries full diagnostics, and repeats preflight plus confirmation', () => {
    assert.match(source, /\/api\/tia\/compile/);
    assert.match(source, /\/api\/tia\/repair/);
    assert.match(source, /rawErrors/);
    assert.match(source, /previousRawErrors/);
    assert.match(source, /repairRound/);
    assert.match(source, /tokenUsed/);
    assert.match(source, /自动修复第.*轮/);
    assert.match(source, /startTiaImport\(repairPreflight/);
    assert.match(source, /repairRound:\s*state\.repairRound/);
});

test('ceiling stop returns full artifacts and offers rollback, retain, and diagnostic export', () => {
    assert.match(source, /lastCode/);
    assert.match(source, /rawErrors\.join\(['"]\\n['"]\)/);
    assert.match(source, /回滚到写入前/);
    assert.match(source, /保留现状自己改/);
    assert.match(source, /导出诊断包/);
    assert.match(source, /pre-overwrite/);
    assert.match(source, /application\/json/);
});

test('multi-block pipeline collects one answer, stops on first failure, and compiles the full project last', () => {
    assert.match(source, /querySelectorAll\(['"]\.send-tia\[data-code\]['"]\)/);
    assert.match(source, /按顺序全部写入/);
    assert.match(source, /runSequentialPipeline/);
    assert.match(source, /break/);
    assert.match(source, /全工程编译/);
    assert.match(source, /✓/);
    assert.match(source, /⟳/);
    assert.match(source, /○/);
});

test('multi-block failure offers reverse-order rollback for overwritten and newly-created blocks', () => {
    assert.match(source, /整体回滚已写入块/);
    assert.match(source, /completed\.slice\(\)\.reverse\(\)/);
    assert.match(source, /rollbackPipelineBlocks/);
    assert.match(source, /rollbackToPreOverwrite/);
    assert.match(source, /\/api\/tia\/rollback\/delete-preflight/);
    assert.match(source, /\/api\/tia\/rollback\/delete/);
    assert.match(source, /删除新建块/);
});
