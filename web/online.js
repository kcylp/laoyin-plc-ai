import { confirmDialog } from './confirm-dialog.js';
import { outputPanel } from './output-panel.js';
import { scaffoldPanel } from './scaffold-panel.js';
import { hardwarePanel } from './hardware-panel.js';

const DANGEROUS_TOOL_RE = /download|delete|remove|force|stop|reset/i;

export const onlineMethods = {
    setupOnlinePanel() {
        this.onlinePanel = document.getElementById('onlinePanel');
        this.onlineLed = document.getElementById('tiaOnlineLed');
        const openBtn = document.getElementById('btnTiaOnline');
        const closeBtn = document.getElementById('odClose');
        const connectBtn = document.getElementById('odConnect');
        const callBtn = document.getElementById('odCall');
        const downloadBtn = document.getElementById('odDownload');
        const monitorBtn = document.getElementById('odMonitor');
        const toolName = document.getElementById('odToolName');
        const argsInput = document.getElementById('odArgs');
        const monitorAddr = document.getElementById('odMonitorAddr');
        const sub = document.getElementById('odSub');
        const toolList = document.getElementById('odToolList');

        if (openBtn && this.onlinePanel) {
            openBtn.addEventListener('click', async () => {
                this.onlinePanel.classList.toggle('hidden');
                if (!this.onlinePanel.classList.contains('hidden')) this.refreshOnlineStatus();
            });
        }
        if (closeBtn && this.onlinePanel) closeBtn.addEventListener('click', () => this.onlinePanel.classList.add('hidden'));

        const ONLINE_TOOL_ZH = {
            '环境自检': 'Bootstrap',
            '状态查询': 'GetState',
            '连接博途': 'Connect',
            '断开连接': 'Disconnect',
            '挂接已打开工程': 'AttachToOpenProject',
            '打开工程': 'OpenProject',
            '创建工程': 'CreateProject',
            '保存工程': 'SaveProject',
            '关闭工程': 'CloseProject',
            '项目树': 'GetProjectTree',
            '软件结构树': 'GetSoftwareTree',
            '编译': 'CompileSoftware',
            '编译诊断': 'CompileAndDiagnosePlc',
            '下载前检查': 'CheckDownloadReadiness',
            '下载到PLC': 'DownloadToPlc',
            '联机': 'GoOnline',
            '脱机': 'GoOffline',
            '在线状态': 'GetOnlineState',
            '一键建工程': 'ScaffoldProject',
            'HMI 画面设计': 'ApplyUnifiedHmiScreenDesignJson',
            'HMI 标签绑定': 'EnsureUnifiedHmiTag',
            'HMI 画面导出': 'ExportHmiScreen',
            'HMI 画面列表': 'GetHmiScreens',
            'HMI 标签预检': 'RunHmiTemplatePlcSyncPrecheckSuite',
            'HMI 属性描述': 'DescribeHmiTag',
            '在线读值(S7)': 'ReadPlcLiveValuesS7',
            '监视表读值': 'ReadPlcWatchTableCurrentValuesReadOnly',
            '在线监视(S7)': 'MonitorWatchTableLiveS7',
            '在线能力探测': 'ProbePlcMonitorOnlineCapabilities',
            '硬件目录搜索': 'SearchHardwareCatalog',
            '添加硬件设备': 'AddDeviceWithFallback',
            '导出块': 'ExportBlock',
            '导入块': 'ImportBlock',
            '导出S7DCL文档': 'ExportBlocksAsDocuments',
            '导入S7DCL文档': 'ImportBlocksFromDocuments',
            '变量表列表': 'GetPlcTagTables',
            '对比在线差异': 'CompareSoftwareToOnline',
        };
        window.__ONLINE_TOOL_ZH = ONLINE_TOOL_ZH;
        const resolveToolName = (input) => {
            const v = String(input || '').trim();
            if (!v) return '';
            if (ONLINE_TOOL_ZH[v]) return ONLINE_TOOL_ZH[v];
            if (/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v)) return v;
            return null;
        };
        const showResult = (ok, title, body, detail) => {
            outputPanel.push({ kind: ok ? 'success' : 'error', title, body: body || '', detail });
        };
        const api = async (method, url, body) => {
            const r = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: body ? JSON.stringify(body) : undefined,
            });
            return { status: r.status, json: await r.json().catch(() => null) };
        };

        this.refreshOnlineStatus = async () => {
            try {
                const r = await api('GET', '/api/tia/mcp/status');
                const j = r.json || {};
                const ready = !!(j.available && j.running && j.initialized);
                if (this.onlineLed) this.onlineLed.className = `tia-led ${ready ? 'is-ok' : 'is-idle'}`;
                if (sub) {
                    if (!j.available) sub.textContent = '未集成在线引擎';
                    else if (ready) sub.textContent = '在线引擎已连接 · ' + (j.serverInfo && j.serverInfo.version || '');
                    else if (j.prewarm === 'warming') sub.textContent = '正在预热博途实例…';
                    else if (j.prewarm === 'failed') sub.textContent = '预热失败 · 待手动连接';
                    else sub.textContent = '在线引擎就绪 · 待连接';
                }
            } catch { /* 静默 */ }
        };

        if (connectBtn) connectBtn.addEventListener('click', async () => {
            showResult(true, '博途连接', '连接中…（冷启动可能需数分钟）');
            connectBtn.disabled = true;
            try {
                const r = await api('POST', '/api/tia/mcp/connect', {});
                const j = r.json || {};
                showResult(!!j.success, '博途连接结果', j.success ? JSON.stringify(j, null, 2) : '连接失败: ' + (j.message || r.status), j);
            } catch (e) {
                showResult(false, '博途连接异常', e.message);
            } finally {
                connectBtn.disabled = false;
                this.refreshOnlineStatus();
                this.refreshRealTree();
            }
        });

        if (callBtn && toolName) callBtn.addEventListener('click', async () => {
            const name = resolveToolName(toolName.value);
            if (name === null) { showResult(false, '工具名未识别', `未识别的功能「${toolName.value.trim()}」,请从下拉选择或输入英文工具名`); return; }
            if (!name) { showResult(false, '工具名缺失', '请选择或输入功能'); return; }
            let args = {};
            if (argsInput && argsInput.value.trim()) {
                try { args = JSON.parse(argsInput.value); }
                catch { showResult(false, '参数错误', '参数不是合法 JSON'); return; }
            }
            let confirmed = false;
            if (DANGEROUS_TOOL_RE.test(name)) {
                const decision = await confirmDialog({
                    level: 'danger',
                    title: '危险工具调用',
                    facts: [{ k: '工具', v: name }],
                    bullets: ['可能修改或停止现场 PLC/工程状态', '请确认当前工程、目标设备与现场安全条件', '该调用会进入后端危险操作确认链路'],
                    requireCheck: '我已确认现场安全',
                    confirmText: '确认执行'
                });
                if (!decision) return;
                confirmed = true;
            }
            showResult(true, '在线工具调用', `调用 ${name} …`);
            callBtn.disabled = true;
            try {
                const r = await api('POST', '/api/tia/mcp/call', { name, args, timeoutMs: 120000, confirmed });
                const j = r.json || {};
                if (j.success) {
                    const body = j.json !== null && j.json !== undefined ? JSON.stringify(j.json, null, 2) : j.text;
                    showResult(true, `${name} 调用结果`, body || '（无返回内容）', j);
                    if (/ReadPlc/i.test(name)) this.inspectorShow('live-values', { ip: args.ip || '', rows: normalizeLiveRows(j.json || j) });
                } else {
                    showResult(false, `${name} 调用失败`, (j.message || '调用失败') + (j.dangerous ? '（危险操作需确认）' : ''), j);
                }
            } catch (e) {
                showResult(false, `${name} 调用异常`, e.message);
            } finally {
                callBtn.disabled = false;
                if (toolName) { toolName.value = ''; toolName.focus(); }
            }
        });

        if (downloadBtn) downloadBtn.addEventListener('click', () => this.openDownloadModal());

        if (monitorBtn && monitorAddr) monitorBtn.addEventListener('click', async () => {
            const addr = monitorAddr.value.trim();
            if (!addr) { showResult(false, '在线读值', '请输入 PLC IP 地址'); return; }
            const itemsInput = document.getElementById('odMonitorItems');
            const items = (itemsInput ? itemsInput.value.trim() : '') || 'M0.0';
            showResult(true, '在线读值', '读取中…');
            monitorBtn.disabled = true;
            try {
                const r = await api('POST', '/api/tia/mcp/call', { name: 'ReadPlcLiveValuesS7', args: { ip: addr, itemsJson: items }, timeoutMs: 120000 });
                const j = r.json || {};
                showResult(!!j.success, '在线读值结果', j.success ? JSON.stringify(j, null, 2) : (j.message || '读值失败'), j);
                if (j.success) this.inspectorShow('live-values', { ip: addr, rows: normalizeLiveRows(j.json || j) });
            } catch (e) {
                showResult(false, '在线读值异常', e.message);
            } finally {
                monitorBtn.disabled = false;
            }
        });

        if (toolList) {
            toolList.innerHTML = Object.entries(ONLINE_TOOL_ZH)
                .map(([zh, en]) => `<option value="${zh}">${en}</option>`)
                .join('');
        }
        const toolListBtn = document.getElementById('odToolListBtn');
        if (toolListBtn) toolListBtn.addEventListener('click', () => this.openToolListModal());
        document.querySelectorAll('[data-hmi-tool]').forEach((btn) => {
            if (btn.dataset.bound === '1') return;
            btn.dataset.bound = '1';
            btn.addEventListener('click', () => {
                if (toolName) {
                    toolName.value = btn.dataset.hmiTool || '';
                    toolName.focus();
                }
            });
        });
        scaffoldPanel.init({ app: this });
        hardwarePanel.init({ app: this });
        this.refreshOnlineStatus();
    },

    openToolListModal() {
        const modal = document.getElementById('toolListModal');
        const itemsEl = document.getElementById('toolListItems');
        const searchEl = document.getElementById('toolListSearch');
        if (!modal || !itemsEl) return;
        modal.classList.remove('hidden');
        const close = document.getElementById('toolListClose');
        if (close && !close.dataset.bound) { close.dataset.bound = '1'; close.addEventListener('click', () => modal.classList.add('hidden')); }
        const zhByEn = {};
        for (const [zh, en] of Object.entries(window.__ONLINE_TOOL_ZH || {})) zhByEn[en] = zh;
        const render = (all) => {
            const kw = (searchEl ? searchEl.value : '').trim().toLowerCase();
            const list = all.filter(t => {
                if (!kw) return true;
                return t.name.toLowerCase().includes(kw) || String(t.zh || '').toLowerCase().includes(kw);
            });
            itemsEl.innerHTML = list.length
                ? list.map(t => `<button class="tool-list-item" type="button" data-tool="${this.escapeAttr(t.name)}" data-zh="${this.escapeAttr(t.zh || '')}"><b>${this.escapeHtml(t.name)}</b>${t.zh ? `<span class="tool-list-zh">${this.escapeHtml(t.zh)}</span>` : ''}</button>`).join('')
                : '<div class="hist-empty">没有匹配的工具</div>';
            itemsEl.querySelectorAll('[data-tool]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const name = btn.dataset.tool;
                    const input = document.getElementById('odToolName');
                    if (input) { input.value = btn.dataset.zh || name; }
                    modal.classList.add('hidden');
                });
            });
        };
        if (searchEl && !searchEl.dataset.bound) {
            searchEl.dataset.bound = '1';
            searchEl.addEventListener('input', () => render(window.__ONLINE_TOOL_LIST || []));
        }
        if (window.__ONLINE_TOOL_LIST && window.__ONLINE_TOOL_LIST.length) {
            render(window.__ONLINE_TOOL_LIST);
        } else {
            fetch('/api/tia/mcp/tools', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } })
                .then(r => r.json())
                .then(j => {
                    const list = ((j && j.tools) || []).map(t => ({ name: t.name, zh: zhByEn[t.name] || '' }));
                    window.__ONLINE_TOOL_LIST = list;
                    render(list);
                })
                .catch(e => { itemsEl.innerHTML = '<div class="hist-empty">工具列表加载失败:' + this.escapeHtml(e.message) + '</div>'; });
        }
    },

    async openDownloadModal() {
        const decision = await confirmDialog({
            level: 'danger',
            title: '下载到 PLC',
            facts: [{ k: '工具', v: 'DownloadToPlc' }, { k: '执行方式', v: '博途在线引擎' }],
            bullets: [
                'CPU 可能短暂停机',
                '请确认现场安全/人员远离设备',
                '请确认当前工程与目标 PLC 一致'
            ],
            requireCheck: '我已确认现场安全',
            confirmText: '确认下载'
        });
        if (!decision) return;
        outputPanel.push({ kind: 'warn', title: '下载到 PLC', body: '下载中…（CPU 可能短暂停机）' });
        try {
            const r = await fetch('/api/tia/mcp/call', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ name: 'DownloadToPlc', args: {}, timeoutMs: 300000, confirmed: true }),
            });
            const j = await r.json().catch(() => null);
            outputPanel.push({
                kind: j && j.success ? 'success' : 'error',
                title: '下载到 PLC 结果',
                body: j && j.success ? JSON.stringify(j.json || j.text || j, null, 2) : ('下载失败: ' + ((j && j.message) || r.status)),
                detail: j
            });
        } catch (e) {
            outputPanel.push({ kind: 'error', title: '下载到 PLC 异常', body: e.message });
        }
    },
};

function normalizeLiveRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.rows)) return payload.rows;
    if (payload && Array.isArray(payload.values)) return payload.values;
    if (payload && typeof payload === 'object') {
        return Object.entries(payload).map(([name, value]) => ({ name, value }));
    }
    return [];
}