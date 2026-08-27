const byId = id => document.getElementById(id);

let currentReport = null;
let latestCompile = null;

function authHeaders(json = false) {
    const headers = { Authorization: `Bearer ${localStorage.getItem('token') || ''}` };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
}

async function reportRequest(path, body) {
    const response = await fetch(path, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
        const message = data.message || (response.status === 409 ? '请先连接博途并打开真实工程。' : `请求失败（HTTP ${response.status}）`);
        throw new Error(message);
    }
    return data;
}

function setStatus(message, error = false) {
    const status = byId('reportStatus');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', error);
}

function setExportEnabled(enabled) {
    for (const id of ['reportDownloadMarkdown', 'reportDownloadWord', 'reportPrintPdf']) {
        const button = byId(id);
        if (button) button.disabled = !enabled;
    }
}

function openReportPanel() {
    byId('reportModal')?.classList.remove('hidden');
}

function closeReportPanel() {
    byId('reportModal')?.classList.add('hidden');
}

function editedReport() {
    if (!currentReport) return null;
    return {
        ...currentReport,
        project: {
            ...currentReport.project,
            projectNumber: byId('reportProjectNumber')?.value || '',
        },
        overview: byId('reportOverview')?.value || '',
        operationLogic: byId('reportOperationLogic')?.value || '',
    };
}

async function renderPreview() {
    const report = editedReport();
    if (!report) return;
    const result = await reportRequest('/api/report/export', { format: 'html', report });
    byId('reportPreview').srcdoc = result.content;
}

async function generateReport() {
    openReportPanel();
    setStatus('正在读取博途软件树、变量表和写入履历...');
    setExportEnabled(false);
    const button = byId('reportGenerate');
    if (button) button.disabled = true;
    try {
        const result = await reportRequest('/api/report/generate', {
            project: { projectNumber: byId('reportProjectNumber')?.value || '' },
            compile: latestCompile || undefined,
        });
        currentReport = result.report;
        byId('reportProjectNumber').value = currentReport.project?.projectNumber || '';
        byId('reportOverview').value = currentReport.overview || '';
        byId('reportOperationLogic').value = currentReport.operationLogic || '';
        await renderPreview();
        setExportEnabled(true);
        setStatus(`已读取 ${currentReport.programBlocks?.length || 0} 个程序块、${currentReport.ioTags?.length || 0} 条 I/O。`);
        byId('reportCompilePrompt')?.classList.add('hidden');
    } catch (error) {
        setStatus(`${error.message} 请先连接博途后重试。`, true);
    } finally {
        if (button) button.disabled = false;
    }
}

function downloadBlob(content, type, filename) {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

function decodeBase64(content) {
    const binary = atob(content);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

async function exportMarkdown() {
    try {
        const result = await reportRequest('/api/report/export', { format: 'markdown', report: editedReport() });
        downloadBlob(result.content, 'text/markdown;charset=utf-8', result.filename);
        setStatus('Markdown 已导出。');
    } catch (error) {
        setStatus(error.message, true);
    }
}

async function exportWord() {
    try {
        setStatus('正在调用 Word COM 生成文档...');
        const result = await reportRequest('/api/report/export', { format: 'docx', report: editedReport() });
        if (result.format === 'docx' && result.encoding === 'base64') {
            downloadBlob(decodeBase64(result.content), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', result.filename);
            setStatus('Word 文档已导出。');
            return;
        }
        downloadBlob(result.content, 'text/html;charset=utf-8', result.filename);
        setStatus(result.message || 'Word 不可用，已降级导出 HTML。', true);
    } catch (error) {
        setStatus(error.message, true);
    }
}

async function printPdf() {
    const printable = window.open('', '_blank');
    if (!printable) {
        setStatus('浏览器阻止了打印窗口，请允许弹窗后重试。', true);
        return;
    }
    try {
        const result = await reportRequest('/api/report/export', { format: 'html', report: editedReport() });
        printable.document.open();
        printable.document.write(result.content);
        printable.document.close();
        printable.addEventListener('load', () => printable.print(), { once: true });
        setStatus('打印窗口已打开，可选择“另存为 PDF”。');
    } catch (error) {
        printable.close();
        setStatus(error.message, true);
    }
}

function watchCompileSuccess() {
    if (typeof MutationObserver !== 'function') return;
    const observer = new MutationObserver(records => {
        for (const record of records) {
            for (const node of record.addedNodes || []) {
                const content = node.textContent || '';
                if (/编译通过/.test(content) && /错误\s*0/.test(content)) {
                    latestCompile = { state: 'Success', errorCount: 0, warningCount: 0, rawMessages: [content] };
                    byId('reportCompilePrompt')?.classList.remove('hidden');
                    return;
                }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

function mountReportPanel() {
    byId('btnDeliveryReport')?.addEventListener('click', openReportPanel);
    byId('reportClose')?.addEventListener('click', closeReportPanel);
    byId('reportGenerate')?.addEventListener('click', generateReport);
    byId('reportPromptGenerate')?.addEventListener('click', generateReport);
    byId('reportPromptDismiss')?.addEventListener('click', () => byId('reportCompilePrompt')?.classList.add('hidden'));
    byId('reportDownloadMarkdown')?.addEventListener('click', exportMarkdown);
    byId('reportDownloadWord')?.addEventListener('click', exportWord);
    byId('reportPrintPdf')?.addEventListener('click', printPdf);
    for (const id of ['reportOverview', 'reportOperationLogic', 'reportProjectNumber']) {
        byId(id)?.addEventListener('change', () => renderPreview().catch(error => setStatus(error.message, true)));
    }
    watchCompileSuccess();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountReportPanel, { once: true });
else mountReportPanel();

export { editedReport, generateReport, renderPreview };
