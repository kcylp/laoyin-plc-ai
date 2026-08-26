const test = require('node:test');
const assert = require('node:assert/strict');

const { explainTiaError, OFFICIAL_TIA_TEMPLATES } = require('../lib/tia-error-hints');
const { sanitizeDiagnostic } = require('../lib/sanitize');

test('official TIA catalog is generated from all 3605 TSV resource rows', () => {
    assert.equal(OFFICIAL_TIA_TEMPLATES.length, 3605);
    assert.ok(OFFICIAL_TIA_TEMPLATES.some(template =>
        template.dll === 'DataExchange'
        && template.key === 'Feedback.MissingIdentifierAttributes'
        && template.en === template.zh));
});

test('uses a non-curated official TSV template as a diagnostic source', () => {
    const hint = explainTiaError('The import failed. The source file contains multiple object definitions.');
    assert.equal(hint.sourceDll, 'BlockLogic');
    assert.equal(hint.sourceKey, 'Openness_Fbk_RestrictMultipleDefinitionOfEntitiesInSourceFileDuringImport');
    assert.match(hint.rootCause, /导入失败.*多个对象定义/);
});

test('explains a missing TIA installation registry entry', () => {
    const hint = explainTiaError('MCP 子进程退出(code=1 signal=null)',
        'Could not find TIA Portal installation path for version 21 in the registry.');
    assert.match(hint.rootCause, /注册表.*博途安装信息/);
    assert.match(hint.nextStep, /Openness.*一键诊断/);
});

test('explains a missing net48 directory as a non-default installation path', () => {
    const hint = explainTiaError('net48 dir missing: D:\\Portal\\PublicAPI\\V21\\net48');
    assert.match(hint.rootCause, /非默认路径/);
    assert.match(hint.nextStep, /一键诊断.*实际路径/);
});

test('explains Openness security rejection with group, relogin and AllowList actions', () => {
    const hint = explainTiaError('Siemens.Engineering.EngineeringSecurityException: access denied');
    assert.match(hint.rootCause, /用户组.*AllowList/);
    assert.match(hint.nextStep, /net localgroup "Siemens TIA Openness"/);
    assert.match(hint.nextStep, /注销.*重新登录/);
    assert.match(hint.nextStep, /绿色版.*重新授权/);
});

test('explains a missing WinCC Unified assembly', () => {
    const hint = explainTiaError("Could not find DLL 'Siemens.Engineering.WinCCUnified' for TIA Portal version 21");
    assert.match(hint.rootCause, /WinCC Unified.*Openness.*不完整/);
    assert.match(hint.nextStep, /博途安装程序.*补装/);
});

test('explains an empty-stderr child exit as likely endpoint protection interference', () => {
    const hint = explainTiaError('MCP 子进程退出(code=1 signal=null)', []);
    assert.match(hint.rootCause, /杀毒|终端管控/);
    assert.match(hint.nextStep, /白名单.*诊断包/);
});

test('explains a group-check timeout as a hidden UAC prompt', () => {
    const hint = explainTiaError('MCP 请求超时(tools/call, 300000ms)', ['Checking Windows group membership']);
    assert.match(hint.rootCause, /UAC.*不可见/);
    assert.match(hint.nextStep, /手动.*Siemens TIA Openness.*重试/);
});

test('keeps a true no-project-open error distinct from Attach failures', () => {
    const hint = explainTiaError('TIA Portal is running but no project is open. Open a project first.');
    assert.match(hint.rootCause, /没有打开工程/);
    assert.match(hint.nextStep, /打开博途.*打开一个工程/);
});

test('explains CLR file-load version mismatch failures', () => {
    for (const input of ['HRESULT: 0x80131509', 'System.IO.FileLoadException']) {
        const hint = explainTiaError(input);
        assert.match(hint.rootCause, /程序集加载失败.*版本不匹配/);
        assert.match(hint.nextStep, /版本/);
    }
});

test('explains Internet-zone blocking with GUI and PowerShell unlock actions', () => {
    const hint = explainTiaError('LoadFrom was blocked because Zone.Identifier marks this file as Internet');
    assert.match(hint.rootCause, /Internet.*阻止加载/);
    assert.match(hint.nextStep, /解除锁定.*Unblock-File/);
});

test('falls back to exporting a diagnostic package for unknown errors', () => {
    const hint = explainTiaError('unexpected opaque TIA failure');
    assert.match(hint.rootCause, /未识别/);
    assert.match(hint.nextStep, /诊断包/);
});

test('classifies Invalid XML as the XML format layer', () => {
    const hint = explainTiaError('Invalid XML document: root element is missing');
    assert.equal(hint.layer, 'xml');
    assert.match(hint.title, /生成的文件格式有误/);
});

test('classifies TSV importer line diagnostics as the SimaticML object layer', () => {
    const hint = explainTiaError("Missing 'UId' identifier attribute from the 'Part' object at line number 42 at line position 7.");
    assert.equal(hint.layer, 'simaticml');
    assert.equal(hint.lineNumber, 42);
    assert.match(hint.title, /块结构.*第 42 行/);
    assert.match(hint.rootCause, /Part.*UId/);
    assert.equal(hint.sourceKey, 'Feedback.MissingIdentifierAttributes');
});

test('classifies network semantics and resolves the reported UID to its XML component', () => {
    const xml = '<FlgNet><Parts><Part Name="O" UId="26" /></Parts></FlgNet>';
    const hint = explainTiaError("Invalid connection at the object with UID '26'.", '', { xml });
    assert.equal(hint.layer, 'network');
    assert.equal(hint.uid, '26');
    assert.match(hint.title, /梯形图内部接线或指令有误/);
    assert.match(hint.component, /UID 26 = Part Name="O"（并联块）/);
});

test('detects real UTF-8-as-GBK corruption by its private-use character', () => {
    const actualMojibake = 'Tag "鍚\uE21A姩" not defined';
    const hint = explainTiaError(actualMojibake);
    assert.equal(hint.category, 'encoding');
    assert.match(hint.rootCause, /编码源头/);
    assert.match(hint.nextStep, /源头改编码.*不能自动修复/);
});

test('type conflicts always remind the user to inspect the block IEC check property', () => {
    for (const input of ['Type conflict', "Data type 'TIME' cannot be converted implicitly to 'DWORD'"]) {
        const hint = explainTiaError(input);
        assert.match(hint.nextStep, /IEC 检查.*块属性.*常规.*开启与关闭/);
    }
});

test('sanitizes absolute paths, credentials and stack frames before browser delivery', () => {
    const raw = [
        'failed at C:\\Users\\alice\\Desktop\\secret\\startup.log',
        'Authorization: Bearer sk-live-super-secret',
        'api_key=abcdef1234567890',
        '    at connect (F:\\app\\routes\\tia.js:20:3)',
        'node:internal/process/task_queues:95:5',
        'Could not find TIA Portal installation path in registry',
    ];
    const clean = sanitizeDiagnostic(raw);
    assert.ok(Array.isArray(clean));
    assert.doesNotMatch(clean.join('\n'), /alice|sk-live|abcdef1234567890|F:\\app|node:internal|at connect/);
    assert.match(clean.join('\n'), /<path>|<redacted>/);
    assert.match(clean.join('\n'), /Could not find TIA Portal installation path/);
});
