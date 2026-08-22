import { confirmDialog } from './confirm-dialog.js';
import { outputPanel } from './output-panel.js';

const state = { spec: null, signature: '' };

function headers() {
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') };
}

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, function (ch) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
}

async function postJson(url, body) {
    const response = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    return { response, json: await response.json().catch(function () { return null; }) };
}

function collect() {
    const family = document.getElementById('scaffoldPlcFamily');
    const project = document.getElementById('scaffoldProjectName');
    const requirement = document.getElementById('scaffoldRequirement');
    const plcFamily = family && family.value ? family.value : 'S7-1500';
    const projectName = String(project && project.value || '').trim();
    const requirementText = String(requirement && requirement.value || '').trim();
    const text = [
        projectName ? '工程名:' + projectName : '',
        'PLC系列:' + plcFamily,
        requirementText ? '需求:' + requirementText : ''
    ].filter(Boolean).join('\n');
    return { plcFamily, projectName, requirementText, requirement: text };
}

function renderPreview(preview, json) {
    if (!preview) return;
    if (!json || !json.success) {
        preview.textContent = json && json.message ? json.message : '预览失败';
        return;
    }
    const dry = json.dryReport || json.runReport || '';
    preview.innerHTML = '<div class="online-preview-title">Spec</div><pre>' + esc(JSON.stringify(json.spec || {}, null, 2)) + '</pre>' +
        '<div class="online-preview-title">dryRun</div><pre>' + esc(typeof dry === 'string' ? dry : JSON.stringify(dry, null, 2)) + '</pre>';
}

export const scaffoldPanel = {
    init({ app } = {}) {
        const root = document.getElementById('scaffoldQuickPanel');
        if (!root || root.dataset.bound === '1') return;
        root.dataset.bound = '1';
        const previewBtn = document.getElementById('scaffoldPreview');
        const runBtn = document.getElementById('scaffoldRun');
        const preview = document.getElementById('scaffoldPreviewBox');

        async function previewSpec() {
            const input = collect();
            if (!input.projectName) {
                outputPanel.push({ kind: 'error', title: '快速建工程', body: '请输入工程名' });
                return null;
            }
            if (!input.requirementText) {
                outputPanel.push({ kind: 'error', title: '快速建工程', body: '请输入工程需求' });
                return null;
            }
            const signature = JSON.stringify(input);
            // A failed re-preview must never leave an older, already-approved spec executable.
            state.spec = null;
            state.signature = '';
            previewBtn.disabled = true;
            if (preview) preview.textContent = '生成 spec 并 dryRun 校验中…';
            try {
                const { response, json } = await postJson('/api/tia/mcp/scaffold', { requirement: input.requirement, confirmed: false });
                renderPreview(preview, json || { success: false, message: String(response.status) });
                if (json && json.success) {
                    state.spec = json.spec;
                    state.signature = signature;
                    outputPanel.push({ kind: 'success', title: '快速建工程预览', body: JSON.stringify(json.dryReport || json.spec || {}, null, 2), detail: json });
                    return json;
                }
                outputPanel.push({ kind: 'error', title: '快速建工程预览失败', body: (json && json.message) || String(response.status), detail: json });
                return null;
            } catch (error) {
                if (preview) preview.textContent = '预览异常:' + error.message;
                outputPanel.push({ kind: 'error', title: '快速建工程预览异常', body: error.message });
                return null;
            } finally {
                previewBtn.disabled = false;
            }
        }

        if (previewBtn) previewBtn.addEventListener('click', previewSpec);
        if (runBtn) runBtn.addEventListener('click', async function () {
            const input = collect();
            if (!state.spec || state.signature !== JSON.stringify(input)) {
                outputPanel.push({ kind: 'warn', title: '快速建工程', body: '请先预览当前需求并通过 dryRun' });
                return;
            }
            const decision = await confirmDialog({
                level: 'danger',
                title: '正式建工程',
                facts: [{ k: '工程名', v: state.spec.projectName || input.projectName }, { k: 'PLC系列', v: state.spec.plcFamily || input.plcFamily }],
                warning: '将调用 TIA Portal 创建/修改工程文件,请确认目标目录与工程名。',
                requireCheck: '我已确认执行正式建工程',
                confirmText: '执行建工程'
            });
            if (!decision) return;
            runBtn.disabled = true;
            outputPanel.push({ kind: 'warn', title: '正式建工程', body: '正在执行 ScaffoldProject dryRun=false…' });
            try {
                const { response, json } = await postJson('/api/tia/mcp/scaffold', { spec: state.spec, confirmed: true });
                renderPreview(preview, json || { success: false, message: String(response.status) });
                outputPanel.push({ kind: json && json.success ? 'success' : 'error', title: '正式建工程结果', body: json && json.success ? JSON.stringify(json.runReport || json.dryReport || json, null, 2) : ((json && json.message) || String(response.status)), detail: json });
                if (json && json.success && app && typeof app.refreshRealTree === 'function') app.refreshRealTree();
            } catch (error) {
                outputPanel.push({ kind: 'error', title: '正式建工程异常', body: error.message });
            } finally {
                runBtn.disabled = false;
            }
        });
    }
};
