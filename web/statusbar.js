export const statusbarMethods = {
    applySeriesUI() {
        this.seriesButtons.forEach(btn => {
            btn.classList.toggle('is-active', btn.dataset.series === this.series);
        });
        this.applyLangUI();
        this.updateStatusbar();
    },

    initializeElements() {
        this.messagesContainer = document.getElementById('messages');
        this.userInput = document.getElementById('userInput');
        this.sendButton = document.getElementById('sendButton');
        this.sendText = document.getElementById('sendText');
        this.sendLoader = document.getElementById('sendLoader');
        this.seriesButtons = document.querySelectorAll('[data-series]');
        this.langButtons = document.querySelectorAll('[data-lang]');
        this.modelSelect = document.getElementById('modelSelect');
        this.modelTestStatus = document.getElementById('modelTestStatus');
        this.clearChatBtn = document.getElementById('btnClear');
        this.projectTree = document.getElementById('projectTree');
        this.inspector = document.getElementById('inspector');
    },

    bindEvents() {
        this.sendButton.addEventListener('click', () => this.sendMessage());
        this.userInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        this.seriesButtons.forEach(btn => {
            btn.addEventListener('click', () => this.setSeries(btn.dataset.series));
        });

        this.langButtons.forEach(btn => {
            btn.addEventListener('click', () => this.setLang(btn.dataset.lang));
        });

        if (this.modelSelect) {
            this.modelSelect.addEventListener('change', () => {
                this.modelId = this.modelSelect.value;
                localStorage.setItem('plcModel', this.modelId);
                this.updateStatusbar();
                this.persistCurrentModel(this.modelId);
            });
        }

        if (this.clearChatBtn) this.clearChatBtn.addEventListener('click', () => this.clearChat());
        const settings = document.getElementById('btnSettings');
        if (settings) settings.addEventListener('click', () => { window.location.href = 'settings.html'; });
        const logout = document.getElementById('btnLogout');
        if (logout) logout.addEventListener('click', () => this.logout());
        const rtRefresh = document.getElementById('rtRefresh');
        if (rtRefresh) rtRefresh.addEventListener('click', () => this.refreshRealTree());
        this.refreshRealTree();
        this.setupOnlinePanel();
    },

    setSeries(series) {
        if (PlcLanguage.normalizeSeries(series) === 's200smart') {
            this.addAssistantMessage('【S7-200 SMART】系列尚未开发，当前仅支持 S7-1200 / S7-1500。');
            return;
        }
        this.series = PlcLanguage.normalizeSeries(series);
        localStorage.setItem('plcSeries', this.series);
        const previousLang = this.lang;
        this.lang = PlcLanguage.normalizeLang(this.series, this.lang);
        localStorage.setItem('plcLang', this.lang);
        this.applySeriesUI();
        this.renderProjectTree();
        const fallbackNotice = previousLang !== this.lang
            ? `当前系列不支持${PlcLanguage.languageLabel(previousLang)}，已切换为${PlcLanguage.languageLabel(this.lang)}。`
            : '';
        this.addAssistantMessage(`已切换到【${PlcLanguage.seriesLabel(this.series)}】系列${fallbackNotice ? '。' + fallbackNotice : ''}。当前语言：${PlcLanguage.languageLabel(this.lang)}。`);
    },

    setLang(lang, silent = false) {
        if (String(lang || '').toLowerCase() === 'graph') {
            if (!silent) this.addAssistantMessage('【GRAPH】语言尚未开发，当前可用 LAD / FBD / SCL / STL。');
            return false;
        }
        const next = PlcLanguage.normalizeLang(this.series, lang);
        if (next !== String(lang || '').toLowerCase()) {
            if (!silent) {
                this.addAssistantMessage(`【${PlcLanguage.seriesLabel(this.series)}】不支持${PlcLanguage.languageLabel(lang)}，当前仍使用${PlcLanguage.languageLabel(next)}。`);
            }
            return false;
        }
        this.lang = next;
        localStorage.setItem('plcLang', next);
        this.applyLangUI();
        this.renderProjectTree();
        if (!silent) this.addAssistantMessage(`已切换编程语言为【${PlcLanguage.languageLabel(next)}】。`);
        return true;
    },

    applyLangUI() {
        this.lang = PlcLanguage.normalizeLang(this.series, this.lang);
        this.langButtons.forEach(btn => {
            const supported = PlcLanguage.availableLangs(this.series).includes(btn.dataset.lang);
            btn.hidden = !supported;
            btn.classList.toggle('is-active', btn.dataset.lang === this.lang);
        });
        this.updateStatusbar();
    },

    setLoading(loading) {
        this.isResponding = loading;
        this.sendButton.disabled = loading;
        this.sendText.classList.toggle('hidden', loading);
        this.sendLoader.classList.toggle('hidden', !loading);
    },

    startTimer() {
        this.timerSeconds = 0;
        this.updateStatusbar('生成中', 'is-idle');
        this.updateTimerDisplay();
        this.timer = setInterval(() => {
            this.timerSeconds++;
            this.updateTimerDisplay();
        }, 1000);
    },

    stopTimer() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.updateStatusbar('就绪', 'is-ok');
    },

    updateTimerDisplay() {
        const elapsed = document.getElementById('stElapsed');
        if (elapsed) elapsed.textContent = `${this.timerSeconds.toFixed(1)}s`;
    },

    scrollToBottom() {
        setTimeout(() => {
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        }, 10);
    },
};