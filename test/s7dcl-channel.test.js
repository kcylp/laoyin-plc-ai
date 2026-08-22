const test = require('node:test');
const assert = require('node:assert/strict');

const { detectPayloadKind, autoFixS7DclTitles } = require('../engineer-yin-bridge');

const S7DCL_SAMPLE = `{
    S7_IECCheck := "TRUE";
    S7_Optimized := "TRUE";
    S7_PreferredLanguage := "LAD";
    S7_Version := "0.1"
}
FUNCTION_BLOCK "FB_Demo"
    VAR_OUTPUT
        Motor : Bool;
    END_VAR
    {
        S7_Language := "LAD";
        S7_NetworkTitle := "起保停"
    }
    NETWORK
        RUNG wire#powerrail
            Contact( #Start )
            Coil( #Motor )
        END_RUNG
    END_NETWORK
END_FUNCTION_BLOCK
`;

test('detectPayloadKind routes S7DCL before STL/SCL lookalikes', () => {
    assert.equal(detectPayloadKind(S7DCL_SAMPLE), 's7dcl');
    // 裸 RUNG 片段也算
    assert.equal(detectPayloadKind('NETWORK\n  RUNG wire#powerrail\n    Contact( #A )\n  END_RUNG\nEND_NETWORK'), 's7dcl');
});

test('autoFixS7DclTitles registers literal titles as MLC ids with .s7res', () => {
    const r = autoFixS7DclTitles(S7DCL_SAMPLE);
    assert.equal(r.changed, true);
    assert.match(r.text, /S7_NetworkTitle := "MLC_t1"/);
    assert.ok(!r.text.includes('起保停'));
    assert.match(r.res, /^MultiLingualTexts:\n/);
    assert.match(r.res, /- id: MLC_t1\n {4}zh-CN: "起保停"/);
    // 已是 MLC 的标题也会被统一登记(幂等产出 .s7res)
    const again = autoFixS7DclTitles(r.text);
    assert.match(again.res, /MLC_t1/);
});

test('autoFixS7DclTitles escapes backslashes in titles for yaml', () => {
    // 标题里不可能有双引号(格式本身以引号定界),但要防反斜杠把 yaml 转义搞坏
    const r = autoFixS7DclTitles('S7_NetworkTitle := "带\\路径的标题"');
    assert.match(r.res, /zh-CN: "带\\\\路径的标题"/);
});
