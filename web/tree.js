import { identifyCodeType } from './code-blocks.js';
import { outputPanel } from './output-panel.js';

export const treeMethods = {
    async refreshRealTree() {
        const wrap = document.getElementById('realTreeWrap');
        const pre = document.getElementById('realTree');
        const blocksEl = document.getElementById('rtBlocks');
        const descEl = document.getElementById('rtDesc');
        if (!wrap || !pre) return;
        try {
            const r = await fetch('/api/tia/mcp/software-tree', {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const j = await r.json().catch(() => null);
            if (j && j.success && j.connected && j.tree) {
                pre.textContent = j.tree.replace(/```/g, '').trim();
                wrap.classList.remove('hidden');
                const blocks = Array.isArray(j.blocks) ? j.blocks : [];
                if (blocksEl && blocks.length) {
                    blocksEl.innerHTML = '<div class="rt-blocks-label">程序块 · 点击解读</div>' +
                        blocks.map(b => `<button class="rt-block" type="button" data-name="${this.escapeAttr(b.name)}" data-path="${this.escapeAttr(b.path)}" title="${this.escapeAttr(b.lang || b.type)}">${this.escapeHtml(b.name)}</button>`).join('');
                    blocksEl.querySelectorAll('[data-name]').forEach(btn => {
                        btn.addEventListener('click', async () => {
                            if (!descEl) return;
                            descEl.classList.remove('hidden');
                            descEl.innerHTML = '<div class="rt-desc-load">解读 <b>' + this.escapeHtml(btn.dataset.name) + '</b> …</div>';
                            if (typeof this.inspectorShow === 'function') {
                                this.inspectorShow('block-logic', { name: btn.dataset.name, language: btn.title || '', readable: '解读中…' });
                            }
                            try {
                                const rr = await fetch('/api/tia/mcp/describe-block', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                                    body: JSON.stringify({ blockPath: btn.dataset.path, name: btn.dataset.name }),
                                });
                                const jj = await rr.json().catch(() => null);
                                if (jj && jj.success && jj.readable) {
                                    const info = { name: jj.blockName || btn.dataset.name, language: jj.language || btn.title || '', readable: jj.readable, blockPath: btn.dataset.path, softwarePath: 'PLC_1' };
                                    descEl.innerHTML =
                                        `<div class="rt-desc-head">${this.escapeHtml(info.name)}<span class="rt-desc-lang">${this.escapeHtml(info.language)}</span><button class="tia-modal-x" type="button" data-desc-close>×</button></div>` +
                                        `<pre class="rt-desc-body">${this.escapeHtml(info.readable)}</pre>`;
                                    if (typeof this.inspectorShow === 'function') this.inspectorShow('block-logic', info);
                                } else {
                                    const body = (jj && jj.message) || String(rr.status);
                                    descEl.innerHTML = `<div class="rt-desc-err">解读失败:${this.escapeHtml(body)}</div>`;
                                    outputPanel.push({ kind: 'error', title: '块解读失败', body, detail: jj || null });
                                    if (typeof this.inspectorShow === 'function') this.inspectorShow('block-logic', { name: btn.dataset.name, language: btn.title || '', readable: '解读失败:' + body });
                                }
                            } catch (e) {
                                descEl.innerHTML = `<div class="rt-desc-err">解读异常:${this.escapeHtml(e.message)}</div>`;
                                outputPanel.push({ kind: 'error', title: '块解读失败', body: e.message });
                                if (typeof this.inspectorShow === 'function') this.inspectorShow('block-logic', { name: btn.dataset.name, language: btn.title || '', readable: '解读异常:' + e.message });
                            }
                            const close = descEl.querySelector('[data-desc-close]');
                            if (close) close.addEventListener('click', () => descEl.classList.add('hidden'));
                        });
                    });
                } else if (blocksEl) {
                    blocksEl.innerHTML = '';
                }
            } else {
                wrap.classList.add('hidden');
            }
        } catch {
            wrap.classList.add('hidden');
        }
    },

    // 在线操作面板（博途在线引擎：连接/编译诊断/下载/读值/建工程 等 201 个工具）,

    renderProjectTree() {
        if (!this.projectTree) return;
        const open = JSON.parse(localStorage.getItem('plcTreeOpenV2') || '{}');
        // 系列/语言选择已由顶部 ribbon 承担,左树不再重复(2026-08-05 用户定)
        const folders = [
            ['blocks', '程序块（会话产物）'],
            ['imports', '导入包'], ['diagnostics', '诊断']
        ];
        const isOpen = (key) => open[key] !== false;
        const folder = (key, label) => `<div class="tia-tree-node is-folder ${isOpen(key) ? 'is-open' : ''}" data-folder="${key}" data-level="1">${label}</div>`;
        const node = (label, attrs, active) => `<button class="tia-tree-node ${active ? 'is-active' : ''}" type="button" data-level="2" ${attrs}>${label}</button>`;
        this.projectTree.innerHTML = `<div class="tia-tree-node" data-level="0">老殷工控PLC</div>${folder('blocks', '程序块（会话产物）')}<div data-tree-section="blocks"></div>${folder('imports', '导入包')}<div data-tree-section="imports"></div>${folder('diagnostics', '诊断')}<div data-tree-section="diagnostics">${node('写入历史', 'data-tree-hist', false)}${node('环境自检', 'data-tree-link="env-check.html"', false)}${node('AI 供应商', 'data-tree-link="settings.html"', false)}</div>`;
        folders.forEach(([key]) => {
            const section = this.projectTree.querySelector(`[data-tree-section="${key}"]`);
            section.hidden = !isOpen(key);
        });
        this.projectTree.querySelectorAll('[data-folder]').forEach(el => el.addEventListener('click', () => {
            const key = el.dataset.folder;
            const nextOpen = !isOpen(key);
            open[key] = nextOpen;
            localStorage.setItem('plcTreeOpenV2', JSON.stringify(open));
            const section = this.projectTree.querySelector(`[data-tree-section="${key}"]`);
            section.hidden = !nextOpen;
            el.classList.toggle('is-open', nextOpen);
        }));
        this.projectTree.querySelectorAll('[data-tree-series]').forEach(el => el.addEventListener('click', () => this.setSeries(el.dataset.treeSeries)));
        this.projectTree.querySelectorAll('[data-tree-lang]').forEach(el => el.addEventListener('click', () => this.setLang(el.dataset.treeLang)));
        this.projectTree.querySelectorAll('[data-tree-link]').forEach(el => el.addEventListener('click', () => { window.location.href = el.dataset.treeLink; }));
        this.projectTree.querySelectorAll('[data-tree-hist]').forEach(el => el.addEventListener('click', () => this.openHistoryModal()));
    },

    // 写入历史(回滚):列出本账号最近写入博途的块快照,回滚走标准预检→确认→写入,

    addTreeBlocks(text, messageElement) {
        if (!this.projectTree || !messageElement) return;
        const section = this.projectTree.querySelector('[data-tree-section="blocks"]');
        if (!section) return;
        const blocks = String(text || '').match(/```(?:xml)?\n?([\s\S]*?)```/g) || [];
        blocks.forEach((block, index) => {
            const code = block.replace(/^```(?:xml)?\n?/, '').replace(/```$/, '');
            const identified = identifyCodeType(code);
            if (identified.type !== 'xml') return;
            const blockName = (code.match(/<Name>([^<]+)<\/Name>/i) || [])[1] || `${identified.lang.toUpperCase()}_${index + 1}`;
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'tia-tree-node';
            item.dataset.level = '2';
            item.textContent = `${blockName} [${identified.lang.toUpperCase()}]`;
            item.addEventListener('click', () => messageElement.scrollIntoView({ behavior: 'smooth', block: 'start' }));
            section.appendChild(item);
        });
    },
};
