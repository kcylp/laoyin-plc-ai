import { startTiaImport } from './tia-actions.js';
import { outputPanel } from './output-panel.js';

export const historyMethods = {
    async openHistoryModal() {
        const modal = document.getElementById('histModal');
        const listEl = document.getElementById('histList');
        if (!modal || !listEl) return;
        modal.classList.remove('hidden');
        listEl.innerHTML = '<div class="hist-empty">加载中…</div>';
        const closeHist = () => modal.classList.add('hidden');
        for (const id of ['histClose', 'histClose2']) {
            const el = document.getElementById(id);
            if (el && !el.dataset.bound) { el.dataset.bound = '1'; el.addEventListener('click', closeHist); }
        }
        try {
            const r = await fetch('/api/tia/history', {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const j = await r.json().catch(() => null);
            if (!j || !j.success) {
                listEl.innerHTML = '<div class="hist-empty">历史读取失败:' + this.escapeHtml((j && j.message) || r.status) + '</div>';
                return;
            }
            if (!j.history.length) {
                listEl.innerHTML = '<div class="hist-empty">还没有写入记录。用「发送至博途」成功写入过程序后，这里会有版本可回滚。</div>';
                return;
            }
            listEl.innerHTML = j.history.map(h => `
                <div class="hist-item">
                    <div class="hist-meta">
                        <b>${this.escapeHtml(h.block_name)}</b>
                        <span class="hist-sub">${this.escapeHtml(h.block_type || '')} ${this.escapeHtml(h.kind || '')} ${this.escapeHtml(h.language || '')}${h.overwrite ? ' · 覆盖' : ''}</span>
                        <span class="hist-sub">${this.escapeHtml(h.created_at || '')}</span>
                    </div>
                    <button class="tia-btn is-ghost is-sm" type="button" data-rollback="${h.id}" data-name="${this.escapeAttr(h.block_name)}">回滚到此版本</button>
                </div>`).join('');
            listEl.querySelectorAll('[data-rollback]').forEach(btn => {
                btn.addEventListener('click', () => this.rollbackToVersion(Number(btn.dataset.rollback), btn.dataset.name));
            });
        } catch (e) {
            listEl.innerHTML = '<div class="hist-empty">历史读取异常:' + this.escapeHtml(e.message) + '</div>';
        }
    },

    async rollbackToVersion(id, name) {
        const modal = document.getElementById('histModal');
        try {
            const r = await fetch('/api/tia/history/' + id, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const j = await r.json().catch(() => null);
            if (!j || !j.success || !j.version) {
                outputPanel.push({ kind: 'error', title: '回滚版本读取失败', body: String((j && j.message) || r.status) });
                return;
            }
            const pre = await fetch('/api/tia/preflight', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ xml: j.version.content, lang: window.plcAssistant ? window.plcAssistant.lang : undefined }),
            }).then(x => x.json());
            if (!pre.success) {
                outputPanel.push({ kind: 'error', title: '回滚预检失败', body: pre.message || '未知错误', detail: pre });
                return;
            }
            if (modal) modal.classList.add('hidden');
            await startTiaImport(pre, { xml: j.version.content, token: localStorage.getItem('token'), btn: null }, {
                level: 'warn',
                title: '回滚到版本 · ' + (name || j.version.blockName || ''),
                outputTitle: '回滚写入结果'
            });
        } catch (e) {
            outputPanel.push({ kind: 'error', title: '回滚请求异常', body: e.message });
        }
    },
};