(function () {
    const token = localStorage.getItem('token') || '';
    if (!token) {
        location.href = '../login.html';
        return;
    }

    const state = { entries: [], activeId: '' };
    const list = document.getElementById('kbList');
    const search = document.getElementById('kbSearch');
    const title = document.getElementById('kbDocTitle');
    const meta = document.getElementById('kbMeta');
    const doc = document.getElementById('kbDoc');
    const warning = document.getElementById('kbWarning');

    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[ch]));
    }

    async function jsonFetch(url) {
        const response = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.success === false) throw new Error(body.message || `HTTP ${response.status}`);
        return body;
    }

    function renderList(entries) {
        if (!entries.length) {
            list.innerHTML = '<div class="kb-empty">没有匹配条目。</div>';
            return;
        }
        const grouped = new Map();
        for (const entry of entries) {
            const key = entry.category || '未分类';
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(entry);
        }
        list.innerHTML = Array.from(grouped.entries()).map(([category, items]) => (
            `<section><h3 class="rg-label">${esc(category)}</h3>` +
            items.map(item => (
                `<button class="kb-item ${item.id === state.activeId ? 'is-active' : ''}" type="button" data-id="${esc(item.id)}">` +
                `<b>${esc(item.title)}</b><small>${esc(item.difficulty || '')} · ${esc(item.review_status || '')}</small></button>`
            )).join('') +
            '</section>'
        )).join('');
        list.querySelectorAll('[data-id]').forEach(button => {
            button.addEventListener('click', () => loadDoc(button.dataset.id));
        });
    }

    async function loadDoc(id) {
        state.activeId = id;
        renderList(state.entries);
        title.textContent = '加载中...';
        warning.innerHTML = '';
        meta.innerHTML = '';
        doc.textContent = '';
        try {
            const body = await jsonFetch(`/api/knowledge/doc/${encodeURIComponent(id)}`);
            const item = body.doc;
            title.textContent = item.title || id;
            warning.innerHTML = item.warning ? `<div class="kb-warning">${esc(item.warning)}</div>` : '';
            meta.innerHTML = [
                item.meta && item.meta.category,
                item.meta && item.meta.difficulty,
                item.review && item.review.status,
                item.file
            ].filter(Boolean).map(value => `<span>${esc(value)}</span>`).join('');
            doc.classList.remove('kb-empty');
            doc.textContent = item.content || item.body || '';
        } catch (error) {
            title.textContent = '读取失败';
            doc.classList.add('kb-empty');
            doc.textContent = error.message;
        }
    }

    async function runSearch() {
        const q = search.value.trim();
        if (!q) {
            renderList(state.entries);
            return;
        }
        const body = await jsonFetch(`/api/knowledge/search?q=${encodeURIComponent(q)}&limit=20`);
        const ids = new Set((body.results || []).map(item => item.id));
        renderList(state.entries.filter(item => ids.has(item.id)));
    }

    async function boot() {
        const body = await jsonFetch('/api/knowledge/index');
        state.entries = body.entries || [];
        renderList(state.entries);
        const params = new URLSearchParams(location.search);
        const q = params.get('q') || '';
        const id = params.get('id') || '';
        if (q) {
            search.value = q;
            await runSearch();
            const hit = state.entries.find(item => item.title === q || item.id === q) || state.entries.find(item => (item.title || '').includes(q));
            if (hit) await loadDoc(hit.id);
        } else if (id) {
            await loadDoc(id);
        }
    }

    document.getElementById('kbSearchBtn').addEventListener('click', () => runSearch().catch(error => { doc.textContent = error.message; }));
    search.addEventListener('keydown', event => {
        if (event.key === 'Enter') runSearch().catch(error => { doc.textContent = error.message; });
    });
    boot().catch(error => {
        list.innerHTML = `<div class="kb-empty">${esc(error.message)}</div>`;
    });
})();
