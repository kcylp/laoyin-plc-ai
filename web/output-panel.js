const MAX_ROWS = 50;
const state = { rows: [] };

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function elements() {
    return {
        root: document.getElementById('outputPanel'),
        title: document.getElementById('outputTitle'),
        toggle: document.getElementById('outputToggle'),
        toggleText: document.getElementById('outputToggleText'),
        list: document.getElementById('outputList'),
        clear: document.getElementById('outputClear'),
    };
}

function render() {
    const el = elements();
    if (!el.root || !el.list) return;
    if (el.title) el.title.textContent = `输出 (${state.rows.length})`;
    if (el.toggleText) el.toggleText.textContent = el.root.classList.contains('collapsed') ? '展开' : '收起';
    if (el.toggle) el.toggle.setAttribute('aria-expanded', String(!el.root.classList.contains('collapsed')));
    el.list.innerHTML = state.rows.map((row) => {
        const detail = row.detail === undefined ? '' : `<pre>${esc(JSON.stringify(row.detail, null, 2))}</pre>`;
        const ms = Number.isFinite(row.ms) ? `<span>${Math.round(row.ms)}ms</span>` : '';
        return `<details class="output-row is-${esc(row.kind || 'info')}"><summary><b>${esc(row.title)}</b>${ms}</summary>${row.body ? `<div>${esc(row.body)}</div>` : ''}${detail}</details>`;
    }).join('');
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
        state.rows.unshift({ kind: row.kind || 'info', title: row.title || '输出', body: row.body || '', detail: row.detail, ms: row.ms });
        state.rows = state.rows.slice(0, MAX_ROWS);
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
        render();
    },
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => outputPanel.init(), { once: true });
} else {
    outputPanel.init();
}
