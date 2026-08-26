import { identifyCodeType } from './code-blocks.js';
import { confirmDialog } from './confirm-dialog.js';
import { outputPanel } from './output-panel.js';

const tiaImportState = window.TiaImportState && window.TiaImportState.createTiaImportState
    ? window.TiaImportState.createTiaImportState()
    : { set() {}, clear() {}, ['confirm']: async () => null };
let tiaResultBtn = null;

function copyCode(btn) {
    const code = btn.getAttribute('data-code');
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => {
        const old = btn.textContent;
        btn.textContent = '✓ 已复制';
        setTimeout(() => { btn.textContent = old; }, 1500);
    }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = code;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        btn.textContent = '✓ 已复制';
        setTimeout(() => { btn.textContent = '复制'; }, 1500);
    });
}

function downloadXml(btn) {
    const code = btn.getAttribute('data-code');
    if (!code) return;
    const blob = new Blob([code], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const seriesName = localStorage.getItem('plcSeries') || 's1200';
    a.href = url;
    a.download = `laoyin_${seriesName}_block.xml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    const old = btn.textContent;
    btn.textContent = '✓ 已下载';
    setTimeout(() => { btn.textContent = old; }, 1500);
}

async function validateXml(btn) {
    const code = btn.getAttribute('data-code');
    if (!code) return;

    const old = btn.textContent;
    btn.textContent = '⏳ 校验中...';
    btn.disabled = true;

    try {
        const token = localStorage.getItem('token');
        const response = await fetch('/api/validate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ xml: code, lang: identifyCodeType(code).lang })
        });
        const data = await response.json();

        const resultBox = getResultBox(btn);
        if (!resultBox) return;

        if (data.success && data.valid) {
            resultBox.className = 'validate-result ok';
            resultBox.textContent = '✅ XSD 校验通过！可以导入博途';
        } else {
            const errList = (data.errors || []).map(e =>
                `  L${e.line}:${e.pos}  ${e.message}`
            ).join('\n');
            resultBox.className = 'validate-result error';
            resultBox.textContent = '❌ XSD 校验失败：\n' + (errList || (data.message || '未知错误'));
        }
    } catch (e) {
        const text = '校验失败：' + e.message;
        outputPanel.push({ kind: 'error', title: 'XSD 校验异常', body: text });
        if (btn) makeResultShower(btn)('error', '❌ ' + text);
    } finally {
        btn.textContent = old;
        btn.disabled = false;
    }
}

async function sendToTia(btn) {
    const code = btn.getAttribute('data-code');
    if (!code) return;

    const token = localStorage.getItem('token');
    const old = btn.textContent;
    btn.disabled = true;
    const showInlineResult = makeResultShower(btn);

    try {
        btn.textContent = '⏳ 正在读取博途...';
        const pre = await fetch('/api/tia/preflight', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({
                xml: code,
                lang: window.plcAssistant ? window.plcAssistant.lang : undefined
            })
        }).then(r => r.json());

        if (!pre.success) {
            const message = formatPreflightFailure(pre);
            showInlineResult('error', message);
            outputPanel.push({ kind: 'error', title: '写入预检失败', body: message, detail: pre });
            return;
        }

        await startTiaImport(pre, { xml: code, token, btn });
    } catch (e) {
        const message = '❌ 请求出错：' + e.message;
        showInlineResult('error', message);
        outputPanel.push({ kind: 'error', title: '写入请求异常', body: message });
    } finally {
        btn.textContent = old;
        btn.disabled = false;
    }
}

function formatPreflightFailure(pre) {
    if (pre && pre.businessErrors && pre.businessErrors.length) {
        const lines = pre.businessErrors.map(e =>
            `· 网络${e.network || '?'} [${e.rule}] ${e.message}` + (e.uid ? `（UId ${e.uid}）` : '')
        ).join('\n');
        return '❌ 梯形图规则校验未通过，尚未连接博途：\n' + lines +
            '\n\n这是 AI 生成的 XML 不符合博途要求，让它按提示重新生成即可。';
    }
    if (/校验|validation|XSD|规则/i.test(String((pre && pre.message) || ''))) {
        return '❌ ' + pre.message + '\n\n（尚未连接博途，是 XML 本身的问题）';
    }
    return '❌ 无法连接博途：\n' + ((pre && pre.message) || '未知错误') +
        '\n\n请确认博途已打开并打开了项目，首次连接时博途会弹出授权提示，需要点“允许”。';
}

function makeResultShower(btn) {
    return (cls, text) => {
        const box = getResultBox(btn);
        if (!box) return;
        box.className = 'validate-result ' + cls;
        box.textContent = text;
    };
}

function getResultBox(btn) {
    const codeBlock = btn && btn.closest ? btn.closest('.code-block') : null;
    if (!codeBlock) return null;
    let box = codeBlock.nextElementSibling;
    if (!box || !box.classList.contains('validate-result')) {
        box = document.createElement('div');
        box.className = 'validate-result';
        codeBlock.insertAdjacentElement('afterend', box);
    }
    return box;
}

function buildImportFacts(preflight) {
    const fallback = {};
    const view = window.TiaConfirmation && window.TiaConfirmation.buildTiaConfirmation
        ? window.TiaConfirmation.buildTiaConfirmation(preflight)
        : fallback;
    return {
        view,
        facts: [
            { k: '博途版本', v: view.tiaVersion || preflight.tiaVersion || '—' },
            { k: '项目', v: view.project || preflight.projectName || '—' },
            { k: 'PLC', v: view.plc || preflight.plcName || '—' },
            { k: '块类型', v: view.blockType || preflight.blockType || '—' },
            { k: '块名', v: view.blockName || preflight.blockName || '—' },
            { k: '语言', v: view.language || preflight.language || '—' },
            { k: '现有同名数量', v: view.existingCount ?? preflight.existingCount ?? 0 },
        ]
    };
}

async function startTiaImport(preflight, payload, options = {}) {
    const built = buildImportFacts(preflight);
    const view = built.view;
    const hasSameNameWarning = !!view.warning;
    tiaResultBtn = payload && payload.btn ? payload.btn : null;

    const dialogOptions = {
        level: options.level || (hasSameNameWarning ? 'warn' : 'info'),
        title: '写入博途',
        facts: built.facts,
        warning: view.warning || options.warning || '',
        optionalCheck: hasSameNameWarning ? { id: 'overwrite', label: '覆盖同名块（不可撤销）' } : null,
        confirmText: options.confirmText || '确认写入'
    };
    if (options.title) dialogOptions.title = options.title;
    const decision = await confirmDialog(dialogOptions);
    if (!decision) {
        tiaImportState.clear();
        return null;
    }

    const overwrite = typeof decision === 'object' ? !!(decision.options && decision.options.overwrite) : false;
    tiaImportState.set({
        xml: payload && payload.xml,
        overwrite,
        token: payload && payload.token,
        confirmationToken: preflight.confirmationToken
    });

    try {
        const runImport = tiaImportState['confirm'].bind(tiaImportState);
        const result = await runImport((url, requestOptions) => fetch(url, requestOptions));
        if (result == null) return null;
        showTiaResult(result, options);
        return result;
    } catch (e) {
        const result = { success: false, message: '请求出错：' + e.message };
        showTiaResult(result, options);
        return result;
    } finally {
        tiaImportState.clear();
    }
}

function formatTiaResult(r) {
    const ok = !!(r && r.success);
    let text;
    if (ok) {
        text = '✅ 已写入博途：' + (r.imported && r.imported.length ? r.imported.join(', ') : (r.blockName || '')) +
            '\n本块编译：错误 ' + (r.errorCount || 0) + '，警告 ' + (r.warningCount || 0) +
            '\n去博途里打开这个块就能看到程序。';
        if (r.otherBlockErrors) {
            text += '\n\nℹ️ 项目里其他块还有 ' + r.otherBlockErrors + ' 个编译错误（不是本次写入造成的），' +
                '博途「编译」窗口会一起列出来。';
        }
    } else if (r && r.stage === 'done' && r.errorCount) {
        const blockName = (r.imported && r.imported.length ? r.imported.join(', ') : (r.blockName || '该块'));
        text = '⚠️ 块「' + blockName + '」已写入博途，但本块编译不通过（' + r.errorCount + ' 个错误）\n' +
            '博途里能看到这个块，需要修正后重新生成。\n\n编译错误：';
        const msgs = (r.messages || []).filter(m => /^Error/i.test(m));
        const shown = msgs.length ? msgs : (r.messages || []);
        text += '\n· ' + shown.slice(0, 8).join('\n· ');
        if (shown.length > 8) text += '\n· …还有 ' + (shown.length - 8) + ' 条，详见博途「编译」窗口';
        if (shown.some(m => /is not supported by the CPU or library version/i.test(m))) {
            text += '\n\n💡 常见原因：SCL 正文引用本块变量时漏了 # 前缀（应写 #Start 而不是 Start），' +
                '博途会把它当成函数名去查库。可以让 AI 重新生成一次。';
        }
        if (shown.some(m => /Tag ".*" not defined/i.test(m))) {
            text += '\n\n💡 出现乱码变量名（如 Tag "鍚姩"）说明接口区用了带双引号的中文变量名，' +
                '博途源码解析器不支持。平台会自动去引号，若仍失败请让 AI 用英文变量名。';
        }
    } else {
        text = '❌ 写入失败' + (r && r.stage ? '（阶段：' + r.stage + '）' : '') + '\n' + ((r && r.message) || '未知错误');
        if (r && r.errorCount) {
            text += '\n编译错误 ' + r.errorCount + ' 个';
            if (r.messages && r.messages.length) text += '\n' + r.messages.slice(0, 5).join('\n');
        }
    }
    if (r && r.autoFixes && r.autoFixes.length) {
        text += '\n\n🔧 已自动修正：\n· ' + r.autoFixes.join('\n· ');
    }
    const kind = ok ? 'success' : (r && r.stage === 'done' ? 'warn' : 'error');
    return { kind, text };
}

function showTiaResult(r, options = {}) {
    const formatted = formatTiaResult(r || {});
    if (tiaResultBtn) makeResultShower(tiaResultBtn)(formatted.kind === 'success' ? 'ok' : formatted.kind, formatted.text);
    outputPanel.push({
        kind: formatted.kind,
        title: options.outputTitle || '写入结果',
        body: formatted.text,
        detail: r
    });
    const app = window.plcAssistant;
    if (app && typeof app.inspectorShow === 'function') app.inspectorShow('write-result', r || {});
    if ((r && r.success) || (r && r.stage === 'done')) {
        if (app && typeof app.refreshRealTree === 'function') app.refreshRealTree();
    }
}

export {
    copyCode,
    downloadXml,
    validateXml,
    sendToTia,
    startTiaImport
};
