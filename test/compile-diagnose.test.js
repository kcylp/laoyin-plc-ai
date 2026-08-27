const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_COMPILE_LOOP_LIMITS,
    diagnoseCompileResult,
    evaluateCompileLoop,
    resolveCompileLoopLimits,
} = require('../lib/compile-diagnose');

const CASES = [
    ['tag-not-defined', 'Error Path=FB_Motor Network=2 Line=18 BL_PARSE_111B: Tag "StartCmd" not defined', /变量.*未定义/],
    ['type-mismatch', 'Error Path=FB_Motor Network=3 Line=21 E1002: Type mismatch: cannot convert TIME to INT', /类型不匹配/],
    ['missing-local-prefix', 'Error Path=FB_Motor Network=1 Line=9: Start is not supported by the CPU or library version', /#.*前缀/],
    ['interface-mismatch', 'Error Path=Main Network=4 Line=31: Interface mismatch: formal parameter Enable does not exist', /块接口/],
    ['cpu-unsupported', 'Error Path=FB_Axis Network=5 Line=42: Instruction MC_MoveSuperimposed is not supported by the CPU', /CPU.*不支持/],
    ['uid-conflict', 'Error Path=FB_Lad Network=6 Line=55: Duplicate UID 26 already exists', /UID.*冲突/],
    ['encoding-garbled', `Error Path=FB_Motor Network=1 Line=7: Tag "鍚\uE21A姩" not defined`, /编码.*乱码/],
];

for (const [type, message, rootCause] of CASES) {
    test(`compile diagnosis structures ${type}`, () => {
        const [item] = diagnoseCompileResult({ messages: [message] });

        assert.equal(item.type, type);
        assert.equal(item.severity, 'error');
        assert.equal(item.blockName, type === 'interface-mismatch' ? 'Main' : (type === 'cpu-unsupported' ? 'FB_Axis' : (type === 'uid-conflict' ? 'FB_Lad' : 'FB_Motor')));
        assert.ok(Number.isInteger(item.network));
        assert.ok(Number.isInteger(item.line));
        assert.equal(typeof item.code, 'string');
        assert.equal(item.message, message);
        assert.match(item['中文根因'], rootCause);
        assert.ok(item['修复建议'].length > 4);
        assert.equal(typeof item['可自动修复'], 'boolean');
    });
}

test('compile loop limits default to the approved values and accept bounded overrides', () => {
    assert.deepEqual(DEFAULT_COMPILE_LOOP_LIMITS, { maxTokens: 100000, maxRepairRounds: 5 });
    assert.deepEqual(resolveCompileLoopLimits({}), DEFAULT_COMPILE_LOOP_LIMITS);
    assert.deepEqual(resolveCompileLoopLimits({ maxTokens: 12000, maxRepairRounds: 2 }), {
        maxTokens: 12000,
        maxRepairRounds: 2,
    });
    assert.deepEqual(resolveCompileLoopLimits({ maxTokens: -1, maxRepairRounds: 'bad' }), DEFAULT_COMPILE_LOOP_LIMITS);
});

test('token ceiling stops first and returns the last code plus raw errors without truncation', () => {
    const rawErrors = [
        'Error Path=FB_Motor Line=18: Tag "StartCmd" not defined',
        'Error Path=FB_Motor Line=19: Tag "StopCmd" not defined',
    ];
    const lastCode = 'FUNCTION_BLOCK "FB_Motor"\nBEGIN\nEND_FUNCTION_BLOCK';
    const result = evaluateCompileLoop({
        repairRound: 2,
        tokenUsed: 100000,
        lastCode,
        rawErrors,
    }, { maxTokens: 100000, maxRepairRounds: 5 });

    assert.equal(result.stop, true);
    assert.equal(result.stopReason, 'token-limit');
    assert.equal(result.lastCode, lastCode);
    assert.deepEqual(result.rawErrors, rawErrors);
    assert.match(result.message, /100,000 token/);
});

test('repair round ceiling stops and returns all remaining errors', () => {
    const rawErrors = ['E1', 'E2', 'E3'];
    const result = evaluateCompileLoop({
        repairRound: 5,
        tokenUsed: 9000,
        lastCode: 'LAST_CODE',
        rawErrors,
    }, { maxTokens: 100000, maxRepairRounds: 5 });

    assert.equal(result.stop, true);
    assert.equal(result.stopReason, 'round-limit');
    assert.equal(result.lastCode, 'LAST_CODE');
    assert.deepEqual(result.rawErrors, rawErrors);
    assert.match(result.message, /5 轮/);
});

test('identical consecutive compiler errors stop the loop early', () => {
    const result = evaluateCompileLoop({
        repairRound: 2,
        tokenUsed: 1000,
        lastCode: 'LAST_CODE',
        rawErrors: ['same error'],
        previousRawErrors: ['same error'],
    });

    assert.equal(result.stop, true);
    assert.equal(result.stopReason, 'same-errors');
    assert.deepEqual(result.rawErrors, ['same error']);
});

test('loop continues while below both ceilings and errors changed', () => {
    const result = evaluateCompileLoop({
        repairRound: 1,
        tokenUsed: 999,
        lastCode: 'CODE',
        rawErrors: ['new error'],
        previousRawErrors: ['old error'],
    }, { maxTokens: 12000, maxRepairRounds: 2 });

    assert.equal(result.stop, false);
    assert.equal(result.stopReason, '');
    assert.equal(result.limits.maxTokens, 12000);
    assert.equal(result.limits.maxRepairRounds, 2);
});
