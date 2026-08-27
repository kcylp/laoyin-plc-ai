const modalState = { resolver: null, keyHandler: null, previousFocus: null };

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function setHidden(el, hidden) {
    if (el) el.classList.toggle('hidden', hidden);
}

function closeWith(value) {
    const modal = document.getElementById('confirmModal');
    if (modal) modal.classList.add('hidden');
    if (modalState.keyHandler) {
        document.removeEventListener('keydown', modalState.keyHandler, true);
        modalState.keyHandler = null;
    }
    if (modalState.previousFocus && typeof modalState.previousFocus.focus === 'function') {
        modalState.previousFocus.focus();
    }
    modalState.previousFocus = null;
    const resolver = modalState.resolver;
    modalState.resolver = null;
    if (resolver) resolver(value);
}

function getFocusable(modal) {
    return Array.from(modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter(el => !el.disabled && el.offsetParent !== null);
}

export function confirmDialog(opts = {}) {
    const modal = document.getElementById('confirmModal');
    if (!modal) return Promise.resolve(false);

    const level = ['info', 'warn', 'danger'].includes(opts.level) ? opts.level : 'info';
    modal.dataset.level = level;

    const title = document.getElementById('confirmTitle');
    const facts = document.getElementById('confirmFacts');
    const warning = document.getElementById('confirmWarning');
    const bullets = document.getElementById('confirmBullets');
    const requiredWrap = document.getElementById('confirmRequiredWrap');
    const requiredCheck = document.getElementById('confirmRequiredCheck');
    const requiredText = document.getElementById('confirmRequiredText');
    const optionalWrap = document.getElementById('confirmOptionalWrap');
    const optionalCheck = document.getElementById('confirmOptionalCheck');
    const optionalText = document.getElementById('confirmOptionalText');
    const ok = document.getElementById('confirmOk');

    if (title) title.textContent = opts.title || '确认';
    if (facts) {
        const rows = Array.isArray(opts.facts) ? opts.facts : [];
        facts.innerHTML = rows.map((row) => `<tr><td>${esc(row.k)}</td><td>${esc(row.v)}</td></tr>`).join('');
        setHidden(facts, rows.length === 0);
    }
    if (warning) {
        warning.className = `tia-alert ${opts.warning ? (level === 'danger' ? 'is-danger' : 'is-warn') : 'hidden'}`;
        warning.textContent = opts.warning || '';
    }
    if (bullets) {
        const list = Array.isArray(opts.bullets) ? opts.bullets : [];
        bullets.innerHTML = list.map((item) => `<li>${esc(item)}</li>`).join('');
        setHidden(bullets, list.length === 0);
    }
    if (requiredCheck) requiredCheck.checked = false;
    if (requiredText) requiredText.textContent = opts.requireCheck || '';
    setHidden(requiredWrap, !opts.requireCheck);
    if (optionalCheck) optionalCheck.checked = false;
    if (optionalText) optionalText.textContent = (opts.optionalCheck && opts.optionalCheck.label) || '';
    setHidden(optionalWrap, !opts.optionalCheck);
    if (ok) {
        ok.textContent = opts.confirmText || '确认';
        ok.className = `tia-btn ${level === 'danger' ? 'is-danger' : 'is-primary'}`;
        ok.disabled = !!opts.requireCheck;
    }

    if (requiredCheck && ok) {
        requiredCheck.onchange = () => { ok.disabled = !!opts.requireCheck && !requiredCheck.checked; };
    }

    for (const id of ['confirmClose', 'confirmCancel']) {
        const el = document.getElementById(id);
        if (el) el.onclick = () => closeWith(false);
    }
    if (ok) ok.onclick = () => {
        if (opts.optionalCheck) {
            closeWith({ confirmed: true, options: { [opts.optionalCheck.id || 'checked']: !!(optionalCheck && optionalCheck.checked) } });
        } else {
            closeWith(true);
        }
    };
    modal.onclick = (event) => { if (event.target === modal) closeWith(false); };

    if (modalState.keyHandler) document.removeEventListener('keydown', modalState.keyHandler, true);
    modalState.previousFocus = document.activeElement;
    modalState.keyHandler = (event) => {
        if (modal.classList.contains('hidden')) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            closeWith(false);
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = getFocusable(modal);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };
    document.addEventListener('keydown', modalState.keyHandler, true);

    modal.classList.remove('hidden');
    const confirmCancel = document.getElementById('confirmCancel');
    if (confirmCancel) confirmCancel.focus();
    return new Promise((resolve) => { modalState.resolver = resolve; });
}

export function closeConfirmDialog() {
    closeWith(false);
}
