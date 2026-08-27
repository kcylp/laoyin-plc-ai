import { identifyCodeType } from './code-blocks.js';
import { confirmDialog } from './confirm-dialog.js';
import { outputPanel } from './output-panel.js';

const tiaImportState = window.TiaImportState && window.TiaImportState.createTiaImportState
    ? window.TiaImportState.createTiaImportState()
    : { set() {}, clear() {}, ['confirm']: async () => null };
let tiaResultBtn = null;

const DEFAULT_COMPILE_LOOP_SETTINGS = Object.freeze({
    autoRepair: false,
    maxTokens: 100000,
    maxRepairRounds: 5,
    skipRepairConfirmations: false,
});

let compileLoopSettings = { ...DEFAULT_COMPILE_LOOP_SETTINGS };

function authHeaders(token, json = false) {
    return {
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        'Authorization': `Bearer ${token}`,
    };
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => null);
    if (!data) throw new Error(`服务返回了无效响应（HTTP ${response.status || '未知'}）`);
    return data;
}

function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 3);
}

function normalizeCompileLoopSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        autoRepair: typeof source.autoRepair === 'boolean' ? source.autoRepair : DEFAULT_COMPILE_LOOP_SETTINGS.autoRepair,
        maxTokens: Number.isSafeInteger(source.maxTokens) && source.maxTokens > 0
            ? source.maxTokens
            : DEFAULT_COMPILE_LOOP_SETTINGS.maxTokens,
        maxRepairRounds: Number.isSafeInteger(source.maxRepairRounds) && source.maxRepairRounds > 0
            ? source.maxRepairRounds
            : DEFAULT_COMPILE_LOOP_SETTINGS.maxRepairRounds,
        skipRepairConfirmations: typeof source.skipRepairConfirmations === 'boolean'
            ? source.skipRepairConfirmations
            : DEFAULT_COMPILE_LOOP_SETTINGS.skipRepairConfirmations,
    };
}

async function loadCompileLoopSettings(token) {
    try {
        const data = await fetchJson('/api/tia/compile-loop/settings', {
            headers: authHeaders(token),
        });
        if (data.success) compileLoopSettings = normalizeCompileLoopSettings(data.settings);
    } catch (error) {
        outputPanel.push({ kind: 'warn', title: '自动修复设置读取失败', body: error.message });
    }
    return { ...compileLoopSettings };
}

async function saveCompileLoopSettings(token, settings) {
    const data = await fetchJson('/api/tia/compile-loop/settings', {
        method: 'POST',
        headers: authHeaders(token, true),
        body: JSON.stringify(normalizeCompileLoopSettings(settings)),
    });
    if (!data.success) throw new Error(data.message || '保存失败');
    compileLoopSettings = normalizeCompileLoopSettings(data.settings);
    return { ...compileLoopSettings };
}

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
        const settings = await loadCompileLoopSettings(token);
        const message = btn.closest && (btn.closest('.assistant-message') || btn.closest('.message-content'));
        const blockButtons = message && typeof message.querySelectorAll === 'function'
            ? Array.from(message.querySelectorAll('.send-tia[data-code]'))
            : [];
        if (blockButtons.length > 1) {
            const decision = await confirmDialog({
                level: 'info',
                title: '按顺序全部写入',
                warning: '每个块都会依次预检、确认、写入和编译；任一块失败即停止。',
                bullets: blockButtons.map((item, index) => `○ ${index + 1}. ${blockNameFromCode(item.getAttribute('data-code'))}`),
                confirmText: '按顺序全部写入',
            });
            if (!decision) return;
            await runSequentialPipeline(blockButtons, { token, settings });
            return;
        }
        const outcome = await runCompileLoop(code, { token, settings, btn });
        if (outcome.cancelled) showInlineResult('warn', '已取消，闭环停止。');
    } catch (e) {
        const message = '❌ 请求出错：' + e.message;
        showInlineResult('error', message);
        outputPanel.push({ kind: 'error', title: '写入请求异常', body: message });
    } finally {
        btn.textContent = old;
        btn.disabled = false;
    }
}

function blockNameFromCode(code) {
    const match = String(code || '').match(/(?:FUNCTION_BLOCK|FUNCTION|ORGANIZATION_BLOCK|DATA_BLOCK)\s+"?([^"\s]+)/i);
    return match ? match[1] : '未命名块';
}

function loopProgress(state) {
    return `第 ${state.repairRound}/${state.settings.maxRepairRounds} 轮 · ${state.tokenUsed}/${state.settings.maxTokens} token`;
}

function pushLoopProgress(state, message, kind = 'info', detail) {
    const body = `${loopProgress(state)}\n${message}`;
    outputPanel.push({ kind, title: '生成-编译闭环', body, detail });
    if (state.btn) makeResultShower(state.btn)(kind === 'success' ? 'ok' : kind, body);
}

async function preflightCode(code, state) {
    return fetchJson('/api/tia/preflight', {
        method: 'POST',
        headers: authHeaders(state.token, true),
        body: JSON.stringify({
            xml: code,
            lang: window.plcAssistant ? window.plcAssistant.lang : undefined,
            repairRound: state.repairRound,
        }),
    });
}

async function compileCurrentBlock(state) {
    return fetchJson('/api/tia/compile', {
        method: 'POST',
        headers: authHeaders(state.token, true),
        body: JSON.stringify({ softwarePath: state.softwarePath || 'PLC_1', blockName: state.blockName }),
    });
}

async function requestRepair(state) {
    return fetchJson('/api/tia/repair', {
        method: 'POST',
        headers: authHeaders(state.token, true),
        body: JSON.stringify({
            code: state.code,
            blockName: state.blockName,
            softwarePath: state.softwarePath || 'PLC_1',
            diagnosis: state.diagnosis,
            rawErrors: state.rawErrors,
            previousRawErrors: state.previousRawErrors,
            repairRound: state.repairRound,
            tokenUsed: state.tokenUsed,
        }),
    });
}

function compileErrors(compileResult) {
    if (Array.isArray(compileResult.rawErrors)) return compileResult.rawErrors.map(String);
    if (Array.isArray(compileResult.messages)) {
        return compileResult.messages.filter(item => /^\s*Error\b/i.test(String(item))).map(String);
    }
    return [];
}

async function runCompileLoop(code, context) {
    const state = {
        token: context.token,
        settings: context.settings,
        btn: context.btn || null,
        code,
        blockName: blockNameFromCode(code),
        softwarePath: 'PLC_1',
        repairRound: 0,
        tokenUsed: estimateTokens(code),
        diagnosis: [],
        rawErrors: [],
        previousRawErrors: null,
    };
    let preflight = await preflightCode(state.code, state);
    if (!preflight.success) {
        pushLoopProgress(state, formatPreflightFailure(preflight), 'error', preflight);
        return { success: false, state };
    }
    state.blockName = preflight.blockName || state.blockName;
    state.softwarePath = preflight.softwarePath || state.softwarePath;
    state.existedBefore = Number(preflight.existingCount || 0) > 0;
    state.preOverwriteContent = state.existedBefore ? preflight.previousContent : null;
    const firstImport = await startTiaImport(preflight, { xml: state.code, token: state.token, btn: state.btn });
    if (firstImport == null) return { success: false, cancelled: true, state };
    if (!firstImport.success) return { success: false, state, importResult: firstImport };

    while (true) {
        const compiled = await compileCurrentBlock(state);
        if (!compiled.success) {
            pushLoopProgress(state, compiled.message || '编译请求失败', 'error', compiled);
            return { success: false, state, compileResult: compiled };
        }
        state.diagnosis = Array.isArray(compiled.diagnosis) ? compiled.diagnosis : [];
        state.rawErrors = compileErrors(compiled);
        if (state.rawErrors.length === 0 && Number(compiled.errorCount || 0) === 0) {
            pushLoopProgress(state, `✓ ${state.blockName} 编译通过，错误 0`, 'success', compiled);
            return { success: true, state, compileResult: compiled };
        }
        if (!state.settings.autoRepair) {
            pushLoopProgress(state, `自动修复已关闭，保留手动处理。\n${state.rawErrors.join('\n')}`, 'warn', compiled);
            return { success: false, manual: true, state, compileResult: compiled };
        }

        const repair = await requestRepair(state);
        if (repair.stopped || !repair.success) {
            const stoppedState = {
                ...state,
                code: repair.lastCode || state.code,
                rawErrors: Array.isArray(repair.rawErrors) ? repair.rawErrors.map(String) : state.rawErrors,
                repairRound: Number.isSafeInteger(repair.repairRound) ? repair.repairRound : state.repairRound,
                tokenUsed: Number.isFinite(repair.tokenUsed) ? repair.tokenUsed : state.tokenUsed,
            };
            showCeilingStop(stoppedState, repair.message || '自动修复已停止', repair.stopReason || 'repair-failed');
            return { success: false, stopped: true, state: stoppedState };
        }

        state.previousRawErrors = [...state.rawErrors];
        state.code = repair.code;
        state.repairRound = repair.repairRound;
        state.tokenUsed = repair.tokenUsed;
        if (state.tokenUsed >= state.settings.maxTokens) {
            showCeilingStop(state, `已达到 ${state.settings.maxTokens} token 上限，自动修复已停止。`, 'token-limit');
            return { success: false, stopped: true, state };
        }
        pushLoopProgress(state, `已生成 ${state.blockName} 修复版，等待写入确认。`, 'info');
        const repairPreflight = await preflightCode(state.code, state);
        if (!repairPreflight.success) {
            pushLoopProgress(state, formatPreflightFailure(repairPreflight), 'error', repairPreflight);
            return { success: false, state };
        }
        const repairedImport = await startTiaImport(repairPreflight, { xml: state.code, token: state.token, btn: state.btn }, {
            level: 'warn',
            title: `自动修复第 ${state.repairRound} 轮`,
            outputTitle: `自动修复第 ${state.repairRound} 轮写入结果`,
            skipConfirmation: state.settings.skipRepairConfirmations,
        });
        if (repairedImport == null) return { success: false, cancelled: true, state };
        if (!repairedImport.success) return { success: false, state, importResult: repairedImport };
    }
}

async function runSequentialPipeline(blockButtons, context) {
    const statuses = blockButtons.map(button => ({
        button,
        name: blockNameFromCode(button.getAttribute('data-code')),
        status: '○',
    }));
    const completed = [];
    for (const item of statuses) {
        item.status = '⟳';
        outputPanel.push({ kind: 'info', title: '顺序写入流水线', body: statuses.map(row => `${row.status} ${row.name}`).join('  ') });
        const outcome = await runCompileLoop(item.button.getAttribute('data-code'), {
            token: context.token,
            settings: context.settings,
            btn: item.button,
        });
        if (!outcome.success) {
            item.status = '✕';
            outputPanel.push({ kind: 'error', title: '顺序写入已停止', body: statuses.map(row => `${row.status} ${row.name}`).join('  '), detail: outcome });
            if (completed.length) {
                const rollback = await confirmDialog({
                    level: 'warn',
                    title: '整体回滚已写入块',
                    warning: '将按写入逆序恢复被覆盖的旧块，并删除本流水线新建的块。每次实际写入或删除仍需单独确认。',
                    bullets: completed.slice().reverse().map(state => `${state.existedBefore ? '恢复' : '删除新建块'} ${state.blockName}`),
                    confirmText: '开始整体回滚',
                });
                if (rollback) await rollbackPipelineBlocks(completed);
            }
            break;
        }
        item.status = '✓';
        completed.push(outcome.state);
    }
    if (completed.length !== statuses.length) return { success: false, completed };
    const state = completed[completed.length - 1];
    const fullCompile = await compileCurrentBlock({ ...state, blockName: '全工程编译' });
    outputPanel.push({
        kind: Number(fullCompile.errorCount || 0) === 0 ? 'success' : 'error',
        title: '全工程编译',
        body: `${statuses.map(row => `${row.status} ${row.name}`).join('  ')}\n错误 ${fullCompile.errorCount || 0}，警告 ${fullCompile.warningCount || 0}`,
        detail: fullCompile,
    });
    return { success: Number(fullCompile.errorCount || 0) === 0, completed, fullCompile };
}

async function rollbackPipelineBlocks(completed) {
    const results = [];
    for (const state of completed.slice().reverse()) {
        const success = state.existedBefore
            ? await rollbackToPreOverwrite(state)
            : await deleteNewPipelineBlock(state);
        results.push({ blockName: state.blockName, success });
        if (!success) {
            outputPanel.push({
                kind: 'error',
                title: '整体回滚已停止',
                body: `${state.blockName} 未完成回滚，后续块未继续处理。`,
                detail: results,
            });
            return { success: false, results };
        }
    }
    outputPanel.push({
        kind: 'success',
        title: '整体回滚完成',
        body: results.map(item => `✓ ${item.blockName}`).join('  '),
        detail: results,
    });
    return { success: true, results };
}

async function deleteNewPipelineBlock(state) {
    try {
        const preflight = await fetchJson('/api/tia/rollback/delete-preflight', {
            method: 'POST',
            headers: authHeaders(state.token, true),
            body: JSON.stringify({ softwarePath: state.softwarePath || 'PLC_1', blockName: state.blockName }),
        });
        if (!preflight.success) throw new Error(preflight.message || '删除预检失败');
        const decision = await confirmDialog({
            level: 'danger',
            title: `删除新建块 · ${state.blockName}` ,
            warning: `该块由本次流水线新建，没有写入前版本。确认后将从 ${preflight.blockPath} 删除。`,
            facts: [
                { k: '块名', v: state.blockName },
                { k: '路径', v: preflight.blockPath },
            ],
            confirmText: '确认删除',
        });
        if (!decision) return false;
        const deleted = await fetchJson('/api/tia/rollback/delete', {
            method: 'POST',
            headers: authHeaders(state.token, true),
            body: JSON.stringify({
                softwarePath: state.softwarePath || 'PLC_1',
                blockName: state.blockName,
                confirmed: true,
                confirmationToken: preflight.confirmationToken,
            }),
        });
        if (!deleted.success) throw new Error(deleted.message || '删除失败');
        outputPanel.push({ kind: 'success', title: '新建块已回滚', body: `✓ 已删除 ${state.blockName}` });
        return true;
    } catch (error) {
        outputPanel.push({ kind: 'error', title: '删除新建块失败', body: error.message });
        return false;
    }
}

function showCeilingStop(state, reason, stopReason) {
    const body = `${reason}\n${loopProgress(state)}\n\n当前最后一版代码：\n${state.code}\n\n剩余编译错误：\n${state.rawErrors.join('\n')}\n\n回滚到写入前 / 保留现状自己改 / 导出诊断包`;
    outputPanel.push({ kind: 'error', title: '自动修复闭环已停止', body, detail: { stopReason, lastCode: state.code, rawErrors: state.rawErrors } });
    if (state.btn) makeResultShower(state.btn)('error', body);
    renderStopActions(state, stopReason);
}

function renderStopActions(state, stopReason) {
    const box = state.btn ? getResultBox(state.btn) : null;
    if (!box || typeof document.createElement !== 'function' || typeof box.appendChild !== 'function') return;
    const actions = document.createElement('div');
    actions.className = 'tia-stop-actions';
    const choices = [
        ['回滚到写入前', () => rollbackToPreOverwrite(state)],
        ['保留现状自己改', () => { if (typeof actions.remove === 'function') actions.remove(); }],
        ['导出诊断包', () => exportDiagnosticBundle(state, stopReason)],
    ];
    for (const [label, handler] of choices) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tia-btn is-ghost is-sm';
        button.textContent = label;
        button.addEventListener('click', handler);
        actions.appendChild(button);
    }
    box.appendChild(actions);
}

async function rollbackToPreOverwrite(state) {
    try {
        let previousContent = state.preOverwriteContent;
        if (previousContent == null) {
        const list = await fetchJson(`/api/tia/history?blockName=${encodeURIComponent(state.blockName)}`, { headers: authHeaders(state.token) });
        const version = Array.isArray(list.history) ? list.history.find(item => item.kind === 'pre-overwrite') : null;
        if (!version) throw new Error('没有找到该块的 pre-overwrite 写入前快照');
        const detail = await fetchJson(`/api/tia/history/${version.id}`, { headers: authHeaders(state.token) });
        if (!detail.success || !detail.version) throw new Error(detail.message || '写入前版本读取失败');
            previousContent = detail.version.content;
        }
        const rollbackPreflight = await preflightCode(previousContent, { ...state, repairRound: 0 });
        if (!rollbackPreflight.success) throw new Error(rollbackPreflight.message || '回滚预检失败');
        const result = await startTiaImport(rollbackPreflight, { xml: previousContent, token: state.token, btn: state.btn }, {
            level: 'warn',
            title: `回滚到写入前 · ${state.blockName}`,
            outputTitle: '写入前版本回滚结果',
        });
        return !!(result && result.success);
    } catch (error) {
        outputPanel.push({ kind: 'error', title: '回滚到写入前失败', body: error.message });
        return false;
    }
}

function exportDiagnosticBundle(state, stopReason) {
    const payload = JSON.stringify({
        exportedAt: new Date().toISOString(),
        stopReason,
        blockName: state.blockName,
        repairRound: state.repairRound,
        tokenUsed: state.tokenUsed,
        settings: state.settings,
        lastCode: state.code,
        rawErrors: state.rawErrors,
        diagnosis: state.diagnosis,
    }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tia-diagnosis-${state.blockName || 'block'}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function mountCompileLoopSettings() {
    if (typeof document.querySelector !== 'function' || document.getElementById('tiaCompileLoopSettings')) return;
    const host = document.querySelector('.output-actions');
    if (!host) return;
    const root = document.createElement('div');
    root.id = 'tiaCompileLoopSettings';
    root.className = 'tia-compile-loop-settings';
    const autoRepair = document.createElement('input');
    autoRepair.type = 'checkbox';
    autoRepair.title = '自动修复';
    const maxTokens = document.createElement('input');
    maxTokens.type = 'number';
    maxTokens.min = '1';
    maxTokens.title = '单次闭环 token 上限';
    const maxRounds = document.createElement('input');
    maxRounds.type = 'number';
    maxRounds.min = '1';
    maxRounds.title = '自动修复轮次上限';
    const skipConfirm = document.createElement('input');
    skipConfirm.type = 'checkbox';
    skipConfirm.title = '首轮之后免确认';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'tia-btn is-ghost is-sm';
    save.textContent = '保存闭环设置';
    for (const [text, input] of [
        ['自动修复', autoRepair],
        ['token 上限', maxTokens],
        ['轮次上限', maxRounds],
        ['后续免确认', skipConfirm],
    ]) {
        const label = document.createElement('label');
        label.textContent = text + ' ';
        label.appendChild(input);
        root.appendChild(label);
    }
    root.appendChild(save);
    host.appendChild(root);
    const token = localStorage.getItem('token');
    loadCompileLoopSettings(token).then(settings => {
        autoRepair.checked = settings.autoRepair;
        maxTokens.value = String(settings.maxTokens);
        maxRounds.value = String(settings.maxRepairRounds);
        skipConfirm.checked = settings.skipRepairConfirmations;
    });
    save.addEventListener('click', async () => {
        save.disabled = true;
        try {
            const saved = await saveCompileLoopSettings(token, {
                autoRepair: autoRepair.checked,
                maxTokens: Number(maxTokens.value),
                maxRepairRounds: Number(maxRounds.value),
                skipRepairConfirmations: skipConfirm.checked,
            });
            outputPanel.push({ kind: 'success', title: '闭环设置已保存', body: `最多 ${saved.maxRepairRounds} 轮 · ${saved.maxTokens} token` });
        } catch (error) {
            outputPanel.push({ kind: 'error', title: '闭环设置保存失败', body: error.message });
        } finally {
            save.disabled = false;
        }
    });
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
    const hasResultClass = box && (
        box.classList && typeof box.classList.contains === 'function'
            ? box.classList.contains('validate-result')
            : /(?:^|\s)validate-result(?:\s|$)/.test(String(box.className || ''))
    );
    if (!box || !hasResultClass) {
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

function formatInterfaceChange(change) {
    const previous = change.previousType ? ` ${change.previousType}` : '';
    const next = change.nextType ? ` -> ${change.nextType}` : '';
    return `${change.type || 'change'} ${change.name || ''}${previous}${next}`.trim();
}

function buildOverwriteDetails(preflight) {
    const interfaceChanges = Array.isArray(preflight.interfaceChanges) ? preflight.interfaceChanges : [];
    const diffLines = Array.isArray(preflight.diffLines) ? preflight.diffLines : [];
    if (!interfaceChanges.length && !diffLines.length) return '';
    const interfaces = interfaceChanges.length
        ? interfaceChanges.map(formatInterfaceChange).join('\n')
        : '无';
    const diff = diffLines.length
        ? diffLines.map(line => `${line.type === 'add' ? '+' : '-'} L${line.line}: ${line.text}`).join('\n')
        : '无';
    return `接口变更（完整）\n${interfaces}\n\n逐行 diff（完整）\n${diff}`;
}

async function startTiaImport(preflight, payload, options = {}) {
    const built = buildImportFacts(preflight);
    const view = built.view;
    const hasSameNameWarning = !!view.warning || Number(preflight.existingCount || 0) > 0;
    const overwriteDetails = buildOverwriteDetails(preflight);
    tiaResultBtn = payload && payload.btn ? payload.btn : null;

    const dialogOptions = {
        level: options.level || (hasSameNameWarning ? 'warn' : 'info'),
        title: '写入博途',
        facts: built.facts,
        warning: [view.warning, options.warning, overwriteDetails].filter(Boolean).join('\n\n'),
        optionalCheck: hasSameNameWarning ? { id: 'overwrite', label: '覆盖同名块（不可撤销）' } : null,
        confirmText: options.confirmText || '确认写入'
    };
    if (options.title) dialogOptions.title = options.title;
    const decision = options.skipConfirmation ? true : await confirmDialog(dialogOptions);
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

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountCompileLoopSettings, { once: true });
    else mountCompileLoopSettings();
}
