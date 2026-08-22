import { outputPanel } from './output-panel.js';

export const inspectorMethods = {
    updateModelTestStatus(status, message = '') {
        const box = this.modelTestStatus;
        if (!box) return;

        const map = {
            passed: { cls: 'is-pass', text: '测试通过' },
            failed: { cls: 'is-fail', text: '测试未通过' },
            testing: { cls: 'is-testing', text: '测试中' },
            unknown: { cls: 'is-idle', text: '未测试' }
        };

        const item = map[status] || map.unknown;
        const led = box.querySelector('.tia-model-test-led');
        const text = box.querySelector('span:not(.tia-model-test-led)');

        if (led) led.className = `tia-model-test-led ${item.cls}`;
        if (text) text.textContent = item.text;
        box.title = message || item.text;
    },

    inspectorShow(type, data) {
        if (type === 'system') {
            if (data) return this.renderInspector(data);
            return this.renderInspectorEmpty();
        }
        if (!this.inspector) return;
        const panes = {
            'block-logic': () => this.renderBlockLogicInspector(data || {}),
            'write-result': () => this.renderWriteResultInspector(data || {}),
            'live-values': () => this.renderLiveValuesInspector(data || {}),
            'tag-table': () => this.renderTagTableInspector(data || {})
        };
        const render = panes[type] || (() => '<div class="tia-empty">上下文暂未加载</div>');
        this.inspector.innerHTML = '<div class="tia-insp-breadcrumb"><span>上下文</span><button class="tia-btn is-ghost is-sm" type="button" data-insp-system>返回系统状态</button></div>' + render();
        const back = this.inspector.querySelector('[data-insp-system]');
        if (back) back.addEventListener('click', () => {
            if (typeof this.loadWorkbenchStatus === 'function') this.loadWorkbenchStatus();
            else this.inspectorShow('system');
        });
        if (type === 'block-logic') this.bindS7DclExport(data || {});
    },

    renderBlockLogicInspector(data) {
        const name = data.name || data.blockName || '—';
        const path = data.blockPath || data.path || '';
        return '<section class="tia-insp-section"><h3><i class="tia-led is-ok"></i>程序块逻辑</h3>' +
            '<div class="tia-insp-row"><span>块名</span><b>' + this.escapeHtml(name) + '</b></div>' +
            '<div class="tia-insp-row"><span>路径</span><b>' + this.escapeHtml(path || 'PLC_1 / Program blocks') + '</b></div>' +
            '<div class="tia-insp-row"><span>语言</span><b>' + this.escapeHtml(data.language || '—') + '</b></div>' +
            '<pre class="rt-desc-body">' + this.escapeHtml(data.readable || '等待解读结果…') + '</pre>' +
            '<div class="od-row"><span class="spacer"></span><button class="tia-btn is-ghost is-sm" type="button" data-export-s7dcl>导出 S7DCL</button></div>' +
            '</section>';
    },

    bindS7DclExport(data) {
        const btn = this.inspector && this.inspector.querySelector('[data-export-s7dcl]');
        if (!btn) return;
        btn.addEventListener('click', async () => {
            if (btn.disabled) return;
            btn.disabled = true;
            try {
                await this.exportS7Dcl(data);
            } finally {
                btn.disabled = false;
            }
        });
    },

    async exportS7Dcl(data) {
        const name = data.name || data.blockName || '';
        const blockPath = data.blockPath || data.path || '';
        outputPanel.push({ kind: 'info', title: '导出 S7DCL', body: '正在导出 ' + (name || blockPath || '当前块') + ' …' });
        try {
            const response = await fetch('/api/tia/mcp/export-s7dcl', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ softwarePath: data.softwarePath || 'PLC_1', blockPath, name })
            });
            const j = await response.json().catch(() => null);
            if (!j || !j.success) {
                outputPanel.push({ kind: 'error', title: '导出 S7DCL 失败', body: (j && j.message) || String(response.status), detail: j });
                return;
            }
            const blob = new Blob([j.content || ''], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = j.filename || ((name || 'blocks') + '.s7dcl');
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            outputPanel.push({ kind: 'success', title: '导出 S7DCL 完成', body: a.download, detail: j });
        } catch (error) {
            outputPanel.push({ kind: 'error', title: '导出 S7DCL 异常', body: error.message });
        }
    },

    renderWriteResultInspector(data) {
        const imported = data.imported && data.imported.length ? data.imported.join(', ') : (data.blockName || '—');
        const messages = (data.messages || []).slice(0, 8).map(m => `<div class="tia-insp-row"><span>消息</span><b>${this.escapeHtml(m)}</b></div>`).join('');
        return `
            <section class="tia-insp-section"><h3><i class="tia-led ${data.success ? 'is-ok' : 'is-idle'}"></i>写入结果</h3>
                <div class="tia-insp-row"><span>块</span><b>${this.escapeHtml(imported)}</b></div>
                <div class="tia-insp-row"><span>阶段</span><b>${this.escapeHtml(data.stage || (data.success ? 'success' : 'failed'))}</b></div>
                <div class="tia-insp-row"><span>错误</span><b>${Number(data.errorCount || 0)}</b></div>
                <div class="tia-insp-row"><span>警告</span><b>${Number(data.warningCount || 0)}</b></div>
                ${data.message ? `<div class="tia-insp-row"><span>说明</span><b>${this.escapeHtml(data.message)}</b></div>` : ''}
                ${messages}
            </section>`;
    },

    renderLiveValuesInspector(data) {
        const rows = Array.isArray(data.rows) ? data.rows : [];
        const table = rows.length ? `<table class="tia-table"><tbody>${rows.map(row => `<tr><td>${this.escapeHtml(row.name || row.address || row.path || '')}</td><td>${this.escapeHtml(row.value ?? row.Value ?? '')}</td></tr>`).join('')}</tbody></table>` : '<div class="tia-empty">暂无读值结果</div>';
        return `
            <section class="tia-insp-section"><h3><i class="tia-led is-ok"></i>在线读值</h3>
                <div class="tia-insp-row"><span>PLC</span><b>${this.escapeHtml(data.ip || '—')}</b></div>
                ${table}
            </section>`;
    },

    renderTagTableInspector(data) {
        const item = data.item || {};
        const name = data.name || (typeof item === 'string' ? item : (item.name || item.Name)) || '变量表';
        const tags = Array.isArray(item.tags) ? item.tags : (Array.isArray(item.Tags) ? item.Tags : []);
        const rows = tags.length ? tags.slice(0, 20).map((tag) => '<tr><td>' + this.escapeHtml(tag.name || tag.Name || '') + '</td><td>' + this.escapeHtml(tag.dataType || tag.DataType || tag.type || '') + '</td><td>' + this.escapeHtml(tag.logicalAddress || tag.Address || tag.address || '') + '</td></tr>').join('') : '';
        const detail = rows ? '<table class="tia-table"><tbody>' + rows + '</tbody></table>' : '<pre class="rt-desc-body">' + this.escapeHtml(typeof item === 'string' ? item : JSON.stringify(item, null, 2)) + '</pre>';
        return '<section class="tia-insp-section"><h3><i class="tia-led is-ok"></i>变量表</h3>' +
            '<div class="tia-insp-row"><span>名称</span><b>' + this.escapeHtml(name) + '</b></div>' + detail +
            '</section>';
    },

    renderInspector(status) {
        if (!this.inspector) return;
        const led = (ok) => `<i class="tia-led ${ok ? 'is-ok' : 'is-idle'}"></i>`;
        const registration = status.registration.approvalRequired ? '企业审批' : '免审批';
        const mail = status.mail.configured ? '已配置' : '未配置';
        this.inspector.innerHTML = `
            <section class="tia-insp-section"><h3>${led(status.user.status === 'approved')}会话</h3><div class="tia-insp-row"><span>用户</span><b>${this.escapeHtml(status.user.name)}</b></div><div class="tia-insp-row"><span>状态</span><b>${status.user.status === 'approved' ? '已授权' : this.escapeHtml(status.user.status)}</b></div><div class="tia-insp-row"><span>注册模式</span><b>${registration}</b></div></section>
            <section class="tia-insp-section"><h3>${led(status.ai.ready)}AI 服务</h3><div class="tia-insp-row"><span>供应商</span><b>${status.ai.providerCount} 个</b></div><div class="tia-insp-row"><span>可用模型</span><b>${status.ai.modelCount} 个</b></div><div class="tia-insp-row"><span>当前模型</span><b>${this.escapeHtml(status.ai.currentModelLabel || '未启用模型')}</b></div><div class="tia-insp-row"><span>就绪</span><b>${status.ai.ready ? '就绪' : '未配置'}</b></div></section>
            <section class="tia-insp-section"><h3><i class="tia-led is-idle"></i>博途 TIA</h3><div class="tia-insp-row"><span>模式</span><b>${this.escapeHtml(status.tia.mode)}</b></div><div class="tia-insp-row"><span>写入</span><b>需逐次确认</b></div></section>
            <section class="tia-insp-section"><h3><i class="tia-led is-idle"></i>运行时</h3><div class="tia-insp-row"><span>Node</span><b>${this.escapeHtml(status.runtime.node)}</b></div><div class="tia-insp-row"><span>邮件</span><b>${mail}</b></div><div class="tia-insp-row"><span>引擎</span><b>已就绪</b></div></section>`;
        const xsd = document.getElementById('stXsd');
        if (xsd) xsd.textContent = String(status.schemaCount);
    },

    renderInspectorEmpty() {
        if (this.inspector) this.inspector.innerHTML = '<div class="tia-empty">状态不可用</div>';
    },

    updateStatusbar(state, ledClass) {
        const series = PlcLanguage.seriesLabel(this.series);
        const lang = String(this.lang || '').toUpperCase();
        const model = this.modelSelect && this.modelSelect.selectedOptions[0]
            ? this.modelSelect.selectedOptions[0].textContent : '—';
        const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
        set('stSeries', series);
        set('stLang', lang);
        set('stModel', model || '—');
        if (state) set('stState', state);
        const led = document.getElementById('stLed');
        if (led && ledClass) led.className = `tia-led ${ledClass}`;
        const tbSeries = document.getElementById('tbSeries');
        if (tbSeries) tbSeries.textContent = series;
    },
};
