const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function htmlEscape(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function htmlDecode(text) {
    return String(text)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

function loadFormattingApi() {
    const root = path.join(__dirname, '..');
    const context = {
        console,
        setTimeout,
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        navigator: { clipboard: { writeText: async () => {} } },
        fetch: async () => ({ json: async () => ({ success: true }) }),
        window: {
            TiaImportState: { createTiaImportState: () => ({ set() {}, clear() {}, confirm: async () => null }) },
            TiaConfirmation: { buildTiaConfirmation: () => ({}) }
        },
        document: {
            addEventListener: () => {},
            createElement: () => ({
                _text: '',
                set textContent(value) { this._text = String(value); },
                get textContent() { return this._text; },
                get innerHTML() { return htmlEscape(this._text); }
            })
        }
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(root, 'plc-language.js'), 'utf8'), context);
    const codeBlocksSrc = fs.readFileSync(path.join(root, 'web', 'code-blocks.js'), 'utf8')
        .replace(/^export\s+/gm, '')
        .replace(/\nexport \{[^}]+\};?\s*$/s, '');
    vm.runInContext(
        codeBlocksSrc + '\n;globalThis.__api = { codeBlockMethods, identifyCodeType };',
        context
    );
    const assistant = Object.create(context.__api.codeBlockMethods);
    return { assistant, identifyCodeType: context.__api.identifyCodeType };
}

function buttons(html) {
    return [...html.matchAll(/<button class="([^"]*)"[^>]*>(.*?)<\/button>/g)]
        .map(m => ({ cls: m[1], text: m[2] }));
}

function firstDataCode(html) {
    const m = html.match(/data-code='([^']*)'/);
    return m ? htmlDecode(m[1]) : null;
}

test('code block actions match XML and text scenarios', () => {
    const { assistant, identifyCodeType } = loadFormattingApi();
    const ladXml = '<Document><ProgrammingLanguage>LAD</ProgrammingLanguage><FlgNet><Part Name="A" /></FlgNet></Document>';
    const sclXml = '<Document><ProgrammingLanguage>SCL</ProgrammingLanguage><StructuredText>IF A THEN B := TRUE; END_IF;</StructuredText></Document>';
    const fbdXml = '<Document><sw:ProgrammingLanguage schemaVersion="1">FBD</sw:ProgrammingLanguage><FlgNet><Part Name="A" /></FlgNet></Document>';

    const ladButtons = buttons(assistant.formatMessage('```xml\n' + ladXml + '\n```'));
    assert.equal(ladButtons.length, 4);
    assert.ok(ladButtons.some(b => b.cls.includes('send-tia')));

    const sclButtons = buttons(assistant.formatMessage('```xml\n' + sclXml + '\n```'));
    assert.deepEqual(sclButtons.map(b => b.text), ['复制', '下载 XML', '校验 XSD']);
    assert.ok(!sclButtons.some(b => b.cls.includes('send-tia')));
    const sclXmlHtml = assistant.formatMessage('```xml\n' + sclXml + '\n```');
    assert.match(sclXmlHtml, /SCL 块级 XML/);
    assert.doesNotMatch(sclXmlHtml, /XML XML/);

    // GRAPH 原生块 XML 尚未完成模板回环验证，不开放自动写入
    const graphXml = '<Document><ProgrammingLanguage>GRAPH</ProgrammingLanguage><Graph><PreOperations /><PostOperations /><AlarmsSettings /></Graph></Document>';
    const graphButtons = buttons(assistant.formatMessage('```xml\n' + graphXml + '\n```'));
    assert.deepEqual(graphButtons.map(b => b.text), ['复制', '下载 XML', '校验 XSD']);
    assert.ok(!graphButtons.some(b => b.cls.includes('send-tia')));

    const textButtons = buttons(assistant.formatMessage('```scl\nIF A THEN B := TRUE; END_IF;\n```'));
    assert.deepEqual(textButtons.map(b => b.text), ['复制']);

    const bareXmlButtons = buttons(assistant.formatMessage(ladXml));
    assert.equal(bareXmlButtons.length, 4);
    assert.ok(bareXmlButtons.some(b => b.cls.includes('send-tia')));

    const fbdButtons = buttons(assistant.formatMessage('```xml\n' + fbdXml + '\n```'));
    assert.equal(fbdButtons.length, 4);
    assert.ok(fbdButtons.some(b => b.cls.includes('send-tia')));
    const fbdDetected = identifyCodeType(fbdXml);
    assert.equal(fbdDetected.type, 'xml');
    assert.equal(fbdDetected.lang, 'fbd');

    const unknownXmlButtons = buttons(assistant.formatMessage('```xml\nnot xml\n```'));
    assert.deepEqual(unknownXmlButtons.map(b => b.text), ['复制', '下载 XML', '校验 XSD']);

    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
    assert.match(appSrc, /window\.copyCode = copyCode/);
    assert.match(appSrc, /window\.downloadXml = downloadXml/);
    assert.match(appSrc, /window\.validateXml = validateXml/);
    assert.match(appSrc, /window\.sendToTia = sendToTia/);
});

test('data-code decodes back to the original XML payload', () => {
    const { assistant } = loadFormattingApi();
    const xml = '<Document><ProgrammingLanguage>LAD</ProgrammingLanguage><FlgNet><Part Name="A &amp; B" /></FlgNet></Document>';
    const html = assistant.formatMessage('```xml\n' + xml + '\n```');
    assert.equal(firstDataCode(html), xml);
});

test('encoded XML code blocks are restored to raw XML with TIA actions', () => {
    const { assistant } = loadFormattingApi();
    const encoded = '&lt;Document&gt;&lt;ProgrammingLanguage&gt;LAD&lt;/ProgrammingLanguage&gt;&lt;FlgNet&gt;&lt;Part Name=&quot;A&quot; /&gt;&lt;/FlgNet&gt;&lt;/Document&gt;';
    const expected = '<Document><ProgrammingLanguage>LAD</ProgrammingLanguage><FlgNet><Part Name="A" /></FlgNet></Document>';
    const html = assistant.formatMessage('```xml\n' + encoded + '\n```');

    assert.equal(firstDataCode(html), expected);
    assert.equal(buttons(html).length, 4);
    assert.ok(buttons(html).some(b => b.cls.includes('send-tia')));
});

test('data-code escapes attribute syntax while preserving the original copy payload', () => {
    const { assistant } = loadFormattingApi();
    const xml = '<Document><ProgrammingLanguage>LAD</ProgrammingLanguage><Title>\' onclick=\'alert(1) &amp; "B"</Title></Document>';
    const html = assistant.formatMessage('```xml\n' + xml + '\n```');

    assert.equal(firstDataCode(html), xml);
    assert.doesNotMatch(html, /data-code='[^']*onclick='alert/);
});

test('data-code preserves quotes, newlines, Unicode, and independent multiple XML blocks', () => {
    const { assistant } = loadFormattingApi();
    const first = '<Document><ProgrammingLanguage>LAD</ProgrammingLanguage>\n<Title>电机 \'A\'</Title>\n</Document>';
    const second = '<Document><ProgrammingLanguage>FBD</ProgrammingLanguage>\n<Title>第二块 &amp; "B"</Title>\n</Document>';
    const markdown = '```xml\n' + first + '\n```\n```xml\n' + second + '\n```';
    const html = assistant.formatMessage(markdown);
    const payloads = [...html.matchAll(/data-code='([^']*)'/g)].map(match => htmlDecode(match[1]));
    const firstPayloads = payloads.filter(payload => payload === first);
    const secondPayloads = payloads.filter(payload => payload === second);

    assert.deepEqual([...new Set(payloads)], [first, second]);
    assert.equal(firstPayloads.length, 4);
    assert.equal(secondPayloads.length, 4);
});

test('unfenced complete SCL after prose becomes a writable source block', () => {
    const { assistant } = loadFormattingApi();
    const scl = [
        'FUNCTION_BLOCK "FB_PumpGroupLevelCtrl"',
        "{ S7_Optimized_Access := 'TRUE' }",
        'VERSION : 0.1',
        'VAR_INPUT',
        '    Enable : Bool;',
        'END_VAR',
        'BEGIN',
        '    #Enable := #Enable;',
        'END_FUNCTION_BLOCK'
    ].join('\n');
    const html = assistant.formatMessage('功能块技术规格说明\n' + scl);

    assert.match(html, /<div class="code-block">/);
    assert.match(html, /<span>SCL<\/span>/);
    // 完整块结构可经 Openness ExternalSources 写入博途（实测 V21 通过）
    assert.deepEqual(buttons(html).map(button => button.text), ['复制', '发送至博途']);
    assert.equal(firstDataCode(html), scl);
});

test('unfenced SCL declarations without a block header still render as copy-only code', () => {
    const { assistant } = loadFormattingApi();
    const scl = [
        'VAR_INPUT',
        '    Start : Bool;',
        '    Stop : Bool;',
        'END_VAR',
        'VAR_OUTPUT',
        '    Motor : Bool;',
        'END_VAR',
        'BEGIN',
        '    IF #Start AND NOT #Stop THEN',
        '        #Motor := TRUE;',
        '    END_IF;',
        'END_FUNCTION_BLOCK'
    ].join('\n');
    const html = assistant.formatMessage('下面是 SCL：\n' + scl);

    assert.match(html, /<div class="code-block">/);
    assert.match(html, /<span>SCL<\/span>/);
    assert.deepEqual(buttons(html).map(button => button.text), ['复制']);
    assert.equal(firstDataCode(html), scl);
});

test('unfenced SCL control-flow snippet renders as copy-only code', () => {
    const { assistant } = loadFormattingApi();
    const scl = [
        'IF #Start AND NOT #Stop THEN',
        '    #Motor := TRUE;',
        'ELSE',
        '    #Motor := FALSE;',
        'END_IF;'
    ].join('\n');
    const html = assistant.formatMessage('SCL 逻辑如下：\n' + scl);

    assert.match(html, /<div class="code-block">/);
    assert.match(html, /<span>SCL<\/span>/);
    assert.deepEqual(buttons(html).map(button => button.text), ['复制']);
    assert.equal(firstDataCode(html), scl);
});

test('unclosed fenced SCL is still rendered as a copy-only code block', () => {
    const { assistant } = loadFormattingApi();
    const scl = [
        'FUNCTION_BLOCK "FB_Test"',
        "{ S7_Optimized_Access := 'TRUE' }",
        'VERSION : 0.1',
        'VAR_INPUT',
        '    Start : Bool;',
        'END_VAR',
        'BEGIN',
        '    #Start := #Start;',
        'END_FUNCTION_BLOCK'
    ].join('\n');
    const html = assistant.formatMessage('这是生成的 SCL：\n```scl\n' + scl);

    assert.match(html, /<div class="code-block">/);
    assert.match(html, /<span>SCL<\/span>/);
    assert.deepEqual(buttons(html).map(button => button.text), ['复制']);
    assert.equal(firstDataCode(html), scl);
});

test('block-level SCL without an END token is boxed instead of flooding the page', () => {
    const { assistant } = loadFormattingApi();
    const scl = [
        'FUNCTION_BLOCK "FB_InProgress"',
        "{ S7_Optimized_Access := 'TRUE' }",
        'VERSION : 0.1',
        'VAR_INPUT',
        '    Start : Bool;',
        'END_VAR',
        'BEGIN',
        '    #Start := #Start;'
    ].join('\n');
    const html = assistant.formatMessage('SCL 代码如下：\n' + scl);

    assert.match(html, /<div class="code-block">/);
    assert.match(html, /<span>SCL<\/span>/);
    assert.deepEqual(buttons(html).map(button => button.text), ['复制']);
    assert.equal(firstDataCode(html), scl);
});

test('visible assistant branding terms are scrubbed without changing code payloads', () => {
    const { assistant } = loadFormattingApi();
    const xml = '<Document><ProgrammingLanguage>LAD</ProgrammingLanguage><Title>Eigen Keep In Code</Title><FlgNet><Part Name="A" /></FlgNet></Document>';
    const html = assistant.formatMessage('Eigen Agent 风格说明\n```xml\n' + xml + '\n```\nCC Switch 参考');

    assert.doesNotMatch(html, /Eigen Agent 风格说明|CC Switch 参考/);
    assert.match(html, /工程智能体 风格说明/);
    assert.equal(firstDataCode(html), xml);
});

test('unfenced XML embedded after prose receives validate and TIA actions', () => {
    const { assistant } = loadFormattingApi();
    const xml = '<Document><ProgrammingLanguage>LAD</ProgrammingLanguage><FlgNet><Part Name="A" /></FlgNet></Document>';
    const html = assistant.formatMessage('已生成梯形图 XML：\n' + xml + '\n请先预检再导入。');

    assert.match(html, /<span>XML<\/span>/);
    assert.equal(firstDataCode(html), xml);
    assert.ok(buttons(html).some(button => button.cls.includes('send-tia')));
});

test('unfenced encoded XML embedded after prose receives TIA actions and raw copy payload', () => {
    const { assistant } = loadFormattingApi();
    const encoded = '&lt;Document&gt;&lt;ProgrammingLanguage&gt;FBD&lt;/ProgrammingLanguage&gt;&lt;FlgNet&gt;&lt;Part Name=&quot;A&quot; /&gt;&lt;/FlgNet&gt;&lt;/Document&gt;';
    const expected = '<Document><ProgrammingLanguage>FBD</ProgrammingLanguage><FlgNet><Part Name="A" /></FlgNet></Document>';
    const html = assistant.formatMessage('已生成：\n' + encoded + '\n请校验。');

    assert.match(html, /<span>XML<\/span>/);
    assert.equal(firstDataCode(html), expected);
    assert.ok(buttons(html).some(button => button.cls.includes('send-tia')));
});

test('ordinary unfenced prose is not converted into a code block', () => {
    const { assistant } = loadFormattingApi();
    const html = assistant.formatMessage('请先确认输入输出点位，然后再生成程序。');

    assert.doesNotMatch(html, /class="code-block"/);
});
