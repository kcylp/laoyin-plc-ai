const MAX_ROWS = 50;
const state = { rows: [], errorsOnly: false };

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function elements() {
    return {
        root: document.getElementById('outputPanel'),
        title: document.getElementById('outputTitle'),
        toggle: document.getElementById('outputToggle'),
        toggleText: document.getElementById('outputToggleText'),
        list: document.getElementById('outputList'),
        clear: document.getElementById('outputClear'),
        copy: document.getElementById('outputCopy'),
        errorsOnly: document.getElementById('outputErrorsOnly'),
    };
}

function render() {
    const el = elements();
    if (!el.root || !el.list) return;
    if (el.title) el.title.textContent = `输出 (${state.rows.length})`;
    if (el.toggleText) el.toggleText.textContent = el.root.classList.contains('collapsed') ? '展开' : '收起';
    if (el.toggle) el.toggle.setAttribute('aria-expanded', String(!el.root.classList.contains('collapsed')));
    const rows = state.errorsOnly ? state.rows.filter(row => ['error', 'warn'].includes(row.kind)) : state.rows;
    el.list.innerHTML = rows.map((row) => {
        const detail = row.detail === undefined ? '' : `<pre>${esc(JSON.stringify(row.detail, null, 2))}</pre>`;
        const ms = Number.isFinite(row.ms) ? `<span>${Math.round(row.ms)}ms</span>` : '';
        return `<details class="output-row is-${esc(row.kind || 'info')}"><summary><b>${esc(row.title)}</b>${ms}</summary>${row.body ? `<div>${esc(row.body)}</div>` : ''}${detail}</details>`;
    }).join('');
    if (el.errorsOnly) el.errorsOnly.textContent = state.errorsOnly ? '显示全部' : '只看错误';
}

function flash() {
    const root = elements().root;
    if (!root) return;
    root.classList.remove('is-flash');
    void root.offsetWidth;
    root.classList.add('is-flash');
    window.setTimeout(() => root.classList.remove('is-flash'), 1600);
}

export const outputPanel = {
    push(row = {}) {
        const kind = row.kind || 'info';
        state.rows.unshift({ kind, title: row.title || '输出', body: row.body || '', detail: row.detail, ms: row.ms });
        state.rows = state.rows.slice(0, MAX_ROWS);
        if (kind === 'error' || kind === 'warn') this.expand();
        render();
        flash();
    },
    toggle() {
        const root = elements().root;
        if (!root) return;
        root.classList.toggle('collapsed');
        render();
    },
    expand() {
        const root = elements().root;
        if (!root) return;
        root.classList.remove('collapsed');
        render();
    },
    collapse() {
        const root = elements().root;
        if (!root) return;
        root.classList.add('collapsed');
        render();
    },
    clear() {
        state.rows = [];
        render();
    },
    copyAll() {
        const text = state.rows.map(row => {
            const detail = row.detail === undefined ? '' : '\n' + JSON.stringify(row.detail, null, 2);
            return `[${row.kind}] ${row.title}\n${row.body || ''}${detail}`;
        }).join('\n\n');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => {});
        }
    },
    toggleErrorsOnly() {
        state.errorsOnly = !state.errorsOnly;
        render();
    },
    count() {
        return state.rows.length;
    },
    init() {
        const el = elements();
        if (el.toggle && !el.toggle.dataset.bound) {
            el.toggle.dataset.bound = '1';
            el.toggle.addEventListener('click', () => outputPanel.toggle());
        }
        if (el.clear && !el.clear.dataset.bound) {
            el.clear.dataset.bound = '1';
            el.clear.addEventListener('click', () => outputPanel.clear());
        }
        if (el.copy && !el.copy.dataset.bound) {
            el.copy.dataset.bound = '1';
            el.copy.addEventListener('click', () => outputPanel.copyAll());
        }
        if (el.errorsOnly && !el.errorsOnly.dataset.bound) {
            el.errorsOnly.dataset.bound = '1';
            el.errorsOnly.addEventListener('click', () => outputPanel.toggleErrorsOnly());
        }
        outputPanel.expand();
        render();
    },
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => outputPanel.init(), { once: true });
} else {
    outputPanel.init();
}
