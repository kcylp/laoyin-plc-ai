const test = require('node:test');
const assert = require('node:assert/strict');

const { resolvePromptKey, resolvePromptContent } = require('../prompt-router');
const prompts = require('../prompts');

test('prompt key follows normalized series and language', () => {
    assert.equal(resolvePromptKey('s1200', 'scl'), 's1200_scl');
    assert.equal(resolvePromptKey('s200smart', 'scl'), 's200smart_stl');
    assert.equal(resolvePromptKey('s1500', undefined), 's1500_scl');
    assert.equal(resolvePromptKey('s1200', 'graph'), 's1200_graph');
    assert.equal(resolvePromptKey('s200smart', 'graph'), 's200smart_stl');
});

test('prompt content only accepts an exact normalized series-language prompt', () => {
    const prompts = {
        s1200: 'legacy 1200',
        s1200_scl: 'scl 1200',
        s200smart: 'legacy smart',
        s200smart_stl: 'stl smart',
        s1200_graph: null
    };

    assert.equal(resolvePromptContent(prompts, 's1200', 'scl'), 'scl 1200');
    assert.equal(resolvePromptContent(prompts, 's200smart', 'scl'), 'stl smart');
    assert.equal(resolvePromptContent(prompts, 's1500', 'lad'), '');
    assert.equal(resolvePromptContent(prompts, 's1200', 'graph'), '');
});

test('S7-1500 LAD prompt keeps verified TON, set, and reset instructions enabled', () => {
    const prompt = prompts.s1500_lad;

    assert.match(prompt, /Part Name="TON"/);
    assert.match(prompt, /Part Name="SCoil"/);
    assert.match(prompt, /Part Name="RCoil"/);
    assert.doesNotMatch(prompt, /定时器建议用 IEC 定时器（TON_TIME 等），但 LAD 的 FlgNet 表示未验证前一律不输出/);
    assert.doesNotMatch(prompt, /需要定时器\/复位时，明确告知用户"该功能请改用 SCL 实现"/);
});

test('SCL prompts require a fenced SCL code block for reliable code actions', () => {
    assert.match(prompts.s1200_scl, /```scl/);
    assert.match(prompts.s1500_scl, /```scl/);
});

test('SCL prompts carry the proven counter / analog / PID rules', () => {
    for (const key of ['s1200_scl', 's1500_scl']) {
        const prompt = prompts[key];
        // 计数器：具体类型 + Q 必须 => 绑定（实测：IEC_COUNTER 与事后 .Q 都编译失败）
        assert.match(prompt, /CTU_INT/);
        assert.match(prompt, /Q => #Done/);
        assert.doesNotMatch(prompt, /- 计数器：CTU（加）、CTD（减）、CTUD（加减）$/);
        // 模拟量标定
        assert.match(prompt, /NORM_X/);
        assert.match(prompt, /SCALE_X/);
        // PID_Compact 多重背景
        assert.match(prompt, /Pid : PID_Compact/);
        // 泛型 IEC_COUNTER：SCL 只能 InOut 只读，驱动必须切 LAD
        assert.match(prompt, /VAR_IN_OUT[\s\S]*只能读取状态|只能读取状态[\s\S]*VAR_IN_OUT/);
    }
});

test('LAD prompts carry the proven counter rules incl. generic IEC_COUNTER', () => {
    for (const key of ['s1200_lad', 's1500_lad']) {
        const prompt = prompts[key];
        assert.match(prompt, /value_type/);
        assert.match(prompt, /Int#5/);
        assert.match(prompt, /IEC_COUNTER/);
        assert.match(prompt, /CTU_INT \/ CTD_INT \/ CTUD_INT/);
    }
});

test('LAD prompts prefer the verified S7DCL text channel over legacy XML', () => {
    for (const key of ['s1200_lad', 's1500_lad']) {
        const prompt = prompts[key];
        assert.match(prompt, /```s7dcl/);
        assert.match(prompt, /RUNG wire#powerrail/);
        assert.match(prompt, /I_Contact/);
        assert.match(prompt, /END_RUNG wire#w1/);
        assert.match(prompt, /S7_Templates := "time_type := Time"/);
        // XML 降级为备选,不再号称唯一基准
        assert.match(prompt, /备选通道：块级 XML/);
        assert.ok(!prompt.includes('【唯一已验证的格式基准】'));
    }
});

test('GRAPH prompts are usable but do not invent unverified native XML', () => {
    assert.match(resolvePromptContent(prompts, 's1200', 'graph'), /不要编造原生 GRAPH XML/);
    assert.match(resolvePromptContent(prompts, 's1500', 'graph'), /不要编造原生 GRAPH XML/);
    assert.match(prompts.s1200_graph, /已验证的 LAD\/FBD XML/);
    assert.match(prompts.s1500_graph, /已验证的 LAD\/FBD XML/);
});
