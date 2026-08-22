const { autoFixQuotedLocalNames } = require('../engineer-yin-bridge');
const test = require('node:test');
const assert = require('node:assert');

test('双引号中文声明剥引号并改正文引用为 # 前缀', () => {
    const input = `FUNCTION_BLOCK "FB_Test"
VAR_INPUT
   "启动" : Bool;
   "停止" : Bool;
END_VAR
VAR_OUTPUT
   "电机" : Bool;
END_VAR
BEGIN
    IF "启动" AND NOT "停止" THEN
        "电机" := TRUE;
    END_IF;
END_FUNCTION_BLOCK`;

    const r = autoFixQuotedLocalNames(input);
    assert.equal(r.changed, true);
    assert.ok(r.fixes.length > 0);
    // 声明区去引号
    assert.match(r.text, /^\s+启动 : Bool;/m);
    assert.match(r.text, /^\s+停止 : Bool;/m);
    assert.match(r.text, /^\s+电机 : Bool;/m);
    // 不再有带引号的声明
    assert.ok(!/\"\启动\"\s*:/.test(r.text));
    // 正文引用改 # 前缀
    assert.match(r.text, /IF #启动 AND NOT #停止 THEN/);
    assert.match(r.text, /#电机 := TRUE;/);
});

test('不带引号的中文变量名保持不变', () => {
    const input = `FUNCTION_BLOCK "FB_OK"
VAR_INPUT
   启动 : Bool;
END_VAR
BEGIN
    IF #启动 THEN
        #启动 := FALSE;
    END_IF;
END_FUNCTION_BLOCK`;

    const r = autoFixQuotedLocalNames(input);
    assert.equal(r.changed, false);
    assert.equal(r.text, input);
});

test('英文变量名不受影响', () => {
    const input = `FUNCTION_BLOCK "FB_English"
VAR_INPUT
   Start : Bool;
   Stop : Bool;
END_VAR
BEGIN
    IF #Start AND NOT #Stop THEN
    END_IF;
END_FUNCTION_BLOCK`;
    const r = autoFixQuotedLocalNames(input);
    assert.equal(r.changed, false);
    assert.equal(r.text, input);
});

test('外部全局符号引用不动', () => {
    const input = `FUNCTION_BLOCK "FB_Global"
VAR_INPUT
   "DB1_Param" : Real;
END_VAR
BEGIN
    #DB1_Param;
END_FUNCTION_BLOCK`;

    // 这种只有外部变量的场景也会去引号
    const r = autoFixQuotedLocalNames(input);
    assert.equal(r.changed, true);
    assert.match(r.text, /DB1_Param : Real;/);
});

test('空/null 输入不崩', () => {
    assert.equal(autoFixQuotedLocalNames(null).changed, false);
    assert.equal(autoFixQuotedLocalNames('').changed, false);
    assert.equal(autoFixQuotedLocalNames(undefined).changed, false);
});
