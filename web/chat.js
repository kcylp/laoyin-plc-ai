import { detectLanguageIntent } from './code-blocks.js';
import { confirmDialog } from './confirm-dialog.js';
import { outputPanel } from './output-panel.js';

export const chatMethods = {
    currentAbortController: null,

    async sendMessage() {
        const message = this.userInput.value.trim();
        if (!message || this.isResponding) return;

        // 整工程模式:自然语言 → AI 产 spec → 离线校验 → 可一键正式建(独立分支)
        const scaffoldMode = document.getElementById('scaffoldMode');
        if (scaffoldMode && scaffoldMode.checked) {
            return this.sendScaffold(message);
        }

        // 检查是否询问 AI 模型
        if (this.isAskingAboutModel(message)) {
            this.addUserMessage(message);
            this.addAssistantMessage('我是老殷工控PLC的专业编程助手，基于先进的大语言模型构建，专为西门子 S7-200 SMART/1200/1500 编程优化。');
            this.userInput.value = '';
            return;
        }

        // 检查问题次数
        const canAsk = await this.checkQuestionLimit();
        if (!canAsk) return;

        // 需求文字里点名了编程语言，但工具栏选的是另一种 → 按文字为准自动切换。
        // 否则用户说"要梯形图"却停在 SCL 标签上，会白生成一次文本代码。
        let switchNotice = '';
        const intended = detectLanguageIntent(message);
        if (intended && intended !== this.lang && this.setLang(intended, true)) {
            switchNotice = `已按需求自动切换到 ${PlcLanguage.languageLabel(intended)}（工具栏「语言」可手动改回）`;
        }

        this.addUserMessage(message);
        this.userInput.value = '';
        if (switchNotice) this.addAssistantMessage(switchNotice);

        await this.getAIResponse(message);
    },

    isAskingAboutModel(message) {
        const modelKeywords = ['哪个AI', '什么AI', '什么模型', 'AI模型', '哪个模型', '什么系统', '基于什么', '用的什么', '你是用什么'];
        return modelKeywords.some(keyword => message.includes(keyword));
    },

    // 整工程模式:与「写块进当前工程」同一个输入框,但走建工程链路:
    // 自然语言 → 我们的模型产 spec → 离线校验 → 用户点「正式建工程」才执行。,

    async sendScaffold(message) {
        this.addUserMessage(message + '（整工程）');
        this.userInput.value = '';
        this.setLoading(true);
        this.startTimer();
        this.currentAbortController = new AbortController();
        const pending = this.addAssistantMessage('', true);
        pending.innerHTML = '<p>正在生成工程 spec...</p><p>阶段 1/3：请求 AI 生成工程结构；阶段 2/3：等待博途队列；阶段 3/3：离线校验。</p>';
        try {
            const r = await fetch('/api/tia/mcp/scaffold', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ requirement: message }),
                signal: this.currentAbortController.signal,
            });
            const j = await r.json().catch(() => null);
            if (j && j.success && j.spec) {
                const dryText = typeof j.dryReport === 'string' ? j.dryReport : JSON.stringify(j.dryReport, null, 2);
                outputPanel.push({ kind: 'info', title: '建工程 dryRun', body: dryText || '(无校验详情)', detail: j.dryReport || null });
                pending.innerHTML =
                    `<p>工程 <b>${this.escapeHtml(j.spec.projectName || '')}</b> 的 spec 已生成（${j.specSource === 'ai' ? 'AI 生成' : '直接提供'}），离线校验如下：</p>` +
                    `<pre class="od-result" style="max-height:180px">${this.escapeHtml(dryText || '(无校验详情)')}</pre>` +
                    `<p style="margin-top:8px"><button class="tia-btn is-danger is-sm" type="button" data-scaffold-run>正式建工程（新项目，不在当前工程内改动）</button></p>` +
                    `<div data-scaffold-result></div>`;
                const runBtn = pending.querySelector('[data-scaffold-run]');
                const resultDiv = pending.querySelector('[data-scaffold-result]');
                runBtn.addEventListener('click', async () => {
                    const countItems = (items) => Array.isArray(items) ? items.length : (items ? 1 : 0);
                    const blockCount = countItems(j.spec.udt) + countItems(j.spec.globalDb) + countItems(j.spec.tagTable);
                    const decision = await confirmDialog({
                        level: 'warn',
                        title: '正式建工程',
                        facts: [
                            { k: '项目名', v: j.spec.projectName || '—' },
                            { k: 'PLC', v: j.spec.plcName || j.spec.plcFamily || '—' },
                            { k: 'HMI', v: j.spec.hmiName || (j.spec.hmiScreens ? '包含 HMI 画面' : '跳过') },
                            { k: '块数', v: String(blockCount) },
                        ],
                        warning: '将在博途中创建新项目、添加硬件、编译并保存。',
                        confirmText: '正式建工程',
                    });
                    if (!decision) return;
                    runBtn.disabled = true;
                    this.setLoading(true);
                    this.startTimer();
                    this.currentAbortController = new AbortController();
                    resultDiv.innerHTML = '<p>正在建工程...</p><p>阶段 1/4：提交执行；阶段 2/4：等待博途队列；阶段 3/4：创建项目和硬件；阶段 4/4：编译保存。</p>';
                    try {
                        const rr = await fetch('/api/tia/mcp/scaffold', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                            body: JSON.stringify({ spec: j.spec, confirmed: true }),
                            signal: this.currentAbortController.signal,
                        });
                        const jj = await rr.json().catch(() => null);
                        const report = jj && (typeof jj.runReport === 'string' ? jj.runReport : JSON.stringify(jj.runReport, null, 2));
                        resultDiv.innerHTML = jj && jj.success
                            ? `<pre class="od-result" style="max-height:220px">${this.escapeHtml(report || '建工程完成')}</pre>`
                            : `<p style="color:var(--tia-err)">建工程失败:${this.escapeHtml((jj && jj.message) || String(rr.status))}</p>`;
                        outputPanel.push({
                            kind: jj && jj.success ? 'success' : 'error',
                            title: '建工程正式报告',
                            body: report || ((jj && jj.message) || String(rr.status)),
                            detail: jj || null,
                        });
                    } catch (e) {
                        const aborted = e.name === 'AbortError';
                        resultDiv.innerHTML = aborted
                            ? '<p>建工程已取消。</p>'
                            : `<p style="color:var(--tia-err)">建工程异常:${this.escapeHtml(e.message)}</p>`;
                        outputPanel.push({
                            kind: aborted ? 'warn' : 'error',
                            title: aborted ? '建工程已取消' : '建工程正式报告异常',
                            body: aborted ? '用户已停止工程创建。' : e.message,
                        });
                        runBtn.disabled = false;
                        return;
                    } finally {
                        this.currentAbortController = null;
                        this.setLoading(false);
                        this.stopTimer();
                    }
                    this.refreshRealTree();
                });
            } else {
                const msg = (j && j.message) || `请求失败(${r.status})`;
                pending.innerHTML = `<p style="color:var(--tia-err)">${this.escapeHtml(msg)}</p>` +
                    (j && j.raw ? `<pre class="od-result" style="max-height:140px">${this.escapeHtml(j.raw)}</pre>` : '');
                outputPanel.push({ kind: 'error', title: '建工程 dryRun 失败', body: msg, detail: j || null });
            }
        } catch (e) {
            const aborted = e.name === 'AbortError';
            pending.innerHTML = aborted
                ? '<p>建工程已取消。</p>'
                : `<p style="color:var(--tia-err)">建工程请求异常:${this.escapeHtml(e.message)}</p>`;
            outputPanel.push({ kind: aborted ? 'warn' : 'error', title: aborted ? '建工程已取消' : '建工程 dryRun 异常', body: aborted ? '用户已停止工程 spec 生成。' : e.message });
        } finally {
            this.currentAbortController = null;
            this.setLoading(false);
            this.stopTimer();
            this.scrollToBottom();
        }
    },

    addUserMessage(message) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message user-message';
        messageDiv.innerHTML = `
            <div class="message-content">
                ${this.escapeHtml(message)}
            </div>
        `;
        this.appendUserActions(messageDiv, message);
        this.messagesContainer.appendChild(messageDiv);
        this.scrollToBottom();
    },

    addAssistantMessage(message, isStreaming = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message assistant-message';
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';

        if (isStreaming) {
            contentDiv.innerHTML = '<span class="typing-cursor"></span>';
        } else {
            contentDiv.innerHTML = this.formatMessage(message);
        }

        messageDiv.appendChild(contentDiv);
        this.messagesContainer.appendChild(messageDiv);
        this.scrollToBottom();

        return contentDiv;
    },

    async getAIResponse(userMessage) {
        this.setLoading(true);
        this.startTimer();

        const assistantMessageContent = this.addAssistantMessage('', true);
        let responseText = '';
        const token = localStorage.getItem('token');
        this.currentAbortController = new AbortController();

        try {
            if (!this.modelId) await this.loadModels();
            if (!this.modelId) throw new Error('当前账号没有已启用模型，请先到设置页保存所选模型');

            const allowProjectContext = this.projectContextAllowed();
            const includeAllVariables = this.projectContextAllVariables();
            const allowKnowledgeContext = this.knowledgeContextAllowed();

            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    message: userMessage,
                    series: this.series,
                    lang: this.lang,
                    modelId: this.modelId,
                    includeContext: allowProjectContext,
                    includeAllVariables,
                    knowledgeEnabled: allowKnowledgeContext,
                    knowledgeTopN: 3,
                    knowledgeMaxPromptChars: 9000,
                    history: this.collectVisibleHistory(),
                    regenerate: !!this.isRegenerating
                }),
                signal: this.currentAbortController.signal
            });

            if (!response.ok) {
                // 尝试读取 JSON 错误信息
                let errMsg = `请求失败(${response.status})`;
                try {
                    const j = await response.json();
                    errMsg = j.message || errMsg;
                    if (j.needUpgrade) {
                        this.addAssistantMessage('您的免费提问次数已用完。请联系管理员升级账户。');
                        this.updateQuestionStatus();
                        return;
                    }
                } catch (e) { /* 忽略 */ }
                throw new Error(errMsg);
            }

            // 读取 SSE 流
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n\n');
                buffer = lines.pop();

                for (const block of lines) {
                    const line = block.trim();
                    if (!line.startsWith('data: ')) continue;
                    const dataStr = line.slice(6);

                    try {
                        const data = JSON.parse(dataStr);
                        if (data.type === 'delta') {
                            responseText += data.content;
                            this.updateStreamingMessage(assistantMessageContent, responseText);
                        } else if (data.type === 'context') {
                            this.lastKnowledgeContext = data.knowledgeContext || null;
                            this.updateContextBar(data.projectContext || {}, this.lastKnowledgeContext);
                            this.lastProjectContextDetails = {
                                project: data.details || data.projectContext || null,
                                knowledge: this.lastKnowledgeContext
                            };
                        } else if (data.type === 'done') {
                            responseText = data.content;
                        } else if (data.type === 'aborted') {
                            responseText = data.message || 'AI 生成已停止';
                            assistantMessageContent.dataset.aborted = '1';
                            throw new DOMException(responseText, 'AbortError');
                        } else if (data.type === 'error') {
                            throw new Error(data.message);
                        }
                    } catch (e) {
                        if (e.message && !e.message.startsWith('Unexpected')) {
                            throw e;
                        }
                    }
                }
            }

            // 完成，渲染格式化内容 + 工具栏
            this.finalizeMessage(assistantMessageContent, responseText);

        } catch (error) {
            if (error.name === 'AbortError') {
                this.finalizeMessage(assistantMessageContent, 'AI 生成已停止');
            } else {
                console.error('AI请求错误:', error);
                this.finalizeMessage(assistantMessageContent, '抱歉，请求出错：' + error.message);
            }
        } finally {
            this.currentAbortController = null;
            this.isRegenerating = false;
            this.setLoading(false);
            this.stopTimer();
        }
    },

    updateStreamingMessage(element, text) {
        const previous = element.dataset.streamText || '';
        element.dataset.streamText = text;
        const hasFence = /```/.test(text);
        if (!hasFence && !element.dataset.streamFormatted) {
            if (!element.__streamTextNode) {
                element.textContent = '';
                element.__streamTextNode = document.createTextNode('');
                element.appendChild(element.__streamTextNode);
                const cursor = document.createElement('span');
                cursor.className = 'typing-cursor';
                element.appendChild(cursor);
            }
            element.__streamTextNode.nodeValue += text.slice(previous.length);
        } else {
            element.dataset.streamFormatted = '1';
            element.innerHTML = this.formatMessage(text, true) + '<span class="typing-cursor"></span>';
        }
        this.scrollToBottom();
    },

    // 格式化为 HTML，识别代码块，并提供复制/下载
    // 注意：先保护代码块内容，避免后续换行/加粗替换污染 XML,

    finalizeMessage(element, text) {
        delete element.dataset.streamText;
        delete element.dataset.streamFormatted;
        element.__streamTextNode = null;
        element.innerHTML = this.formatMessage(text);
        this.linkKnowledgeReferences(element);
        const messageEl = element.closest('.message');
        this.addTreeBlocks(text, messageEl);
        if (messageEl && messageEl.classList.contains('assistant-message')) this.appendTiaErrorActions(messageEl, text);
        if (messageEl && messageEl.classList.contains('assistant-message')) this.appendAssistantActions(messageEl);
        this.scrollToBottom();
    },

    stopGenerating() {
        if (this.currentAbortController) this.currentAbortController.abort();
    },

    appendUserActions(messageDiv, message) {
        const actions = document.createElement('div');
        actions.className = 'message-actions';
        actions.innerHTML = '<button class="tia-btn is-ghost is-xs" type="button" data-edit-resend>编辑重发</button>';
        const btn = actions.querySelector('[data-edit-resend]');
        btn.addEventListener('click', () => {
            if (this.isResponding) return;
            this.userInput.value = message;
            let cursor = messageDiv;
            while (cursor) {
                const next = cursor.nextElementSibling;
                cursor.remove();
                cursor = next;
            }
            this.userInput.focus();
        });
        messageDiv.appendChild(actions);
    },

    appendAssistantActions(messageDiv) {
        if (!messageDiv || messageDiv.querySelector('[data-regenerate]')) return;
        const actions = document.createElement('div');
        actions.className = 'message-actions';
        actions.innerHTML = '<button class="tia-btn is-ghost is-xs" type="button" data-regenerate>重新生成</button>';
        const btn = actions.querySelector('[data-regenerate]');
        btn.addEventListener('click', () => {
            if (this.isResponding) return;
            const previous = this.findPreviousUserMessage(messageDiv);
            if (!previous) return;
            messageDiv.remove();
            this.isRegenerating = true;
            this.getAIResponse(previous);
        });
        messageDiv.appendChild(actions);
    },

    appendTiaErrorActions(messageDiv, text) {
        if (!messageDiv || messageDiv.querySelector('[data-tia-error-actions]')) return;
        const body = String(text || '');
        if (!/(TIA|Openness|博途|MCP|导入|编译|下载|写入|环境|诊断|line number|UID|Invalid XML|请求出错|失败|异常)/i.test(body)) return;
        const actions = document.createElement('div');
        actions.className = 'message-actions';
        actions.dataset.tiaErrorActions = '1';
        actions.innerHTML = [
            '<a class="tia-btn is-ghost is-xs" href="env-check.html">运行环境诊断</a>',
            '<button class="tia-btn is-ghost is-xs" type="button" data-export-diagnose>导出诊断包</button>',
            '<button class="tia-btn is-ghost is-xs" type="button" data-error-regenerate>重新生成</button>'
        ].join('');
        const exportBtn = actions.querySelector('[data-export-diagnose]');
        if (exportBtn) exportBtn.addEventListener('click', async () => {
            exportBtn.disabled = true;
            try {
                const r = await fetch('/api/diagnose/export', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                    body: JSON.stringify({ deep: true })
                });
                const j = await r.json().catch(() => ({}));
                this.addAssistantMessage(j.success === false ? ('诊断包导出失败：' + (j.message || r.status)) : ('诊断包已导出：' + (j.packagePath || j.folder || '请查看诊断输出')));
            } catch (e) {
                this.addAssistantMessage('诊断包导出异常：' + e.message);
            } finally {
                exportBtn.disabled = false;
            }
        });
        const regenBtn = actions.querySelector('[data-error-regenerate]');
        if (regenBtn) regenBtn.addEventListener('click', () => {
            if (this.isResponding) return;
            const previous = this.findPreviousUserMessage(messageDiv);
            if (!previous) return;
            messageDiv.remove();
            this.isRegenerating = true;
            this.getAIResponse(previous);
        });
        messageDiv.appendChild(actions);
    },

    findPreviousUserMessage(messageDiv) {
        let cursor = messageDiv.previousElementSibling;
        while (cursor) {
            if (cursor.classList.contains('user-message')) {
                const content = cursor.querySelector('.message-content');
                return content ? content.textContent.trim() : '';
            }
            cursor = cursor.previousElementSibling;
        }
        return '';
    },

    collectVisibleHistory() {
        return Array.from(this.messagesContainer.querySelectorAll('.message')).map((message) => {
            const content = message.querySelector('.message-content');
            return {
                role: message.classList.contains('user-message') ? 'user' : 'assistant',
                content: content ? content.textContent.trim() : ''
            };
        }).filter(item => item.content);
    },

    async loadChatHistory() {
        try {
            const r = await fetch('/api/chat/history', {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            const j = await r.json().catch(() => null);
            if (!j || !j.success || !Array.isArray(j.messages) || !j.messages.length) return;
            this.messagesContainer.innerHTML = '';
            for (const item of j.messages) {
                if (item.role === 'user') this.addUserMessage(item.content);
                else this.finalizeMessage(this.addAssistantMessage('', true), item.content);
            }
        } catch {
            // 历史恢复失败不阻塞工作台。
        }
    },

    // TASK-009: 上下文指示条
    projectContextAllowed() {
        return localStorage.getItem('allowProjectContext') !== 'false';
    },

    projectContextAllVariables() {
        return localStorage.getItem('projectContextAllVariables') === 'true';
    },

    knowledgeContextAllowed() {
        return localStorage.getItem('knowledgeContextAllowed') !== 'false';
    },

    initializeProjectContextBar() {
        const allow = document.getElementById('ctxAllow');
        const allVars = document.getElementById('ctxAllVars');
        const refresh = document.getElementById('ctxRefresh');
        const detail = document.getElementById('ctxDetail');

        if (allow && !allow.dataset.bound) {
            allow.dataset.bound = '1';
            allow.checked = this.projectContextAllowed();
            allow.addEventListener('change', () => {
                localStorage.setItem('allowProjectContext', allow.checked ? 'true' : 'false');
                if (!allow.checked) this.updateContextBar({ enabled: false });
                else this.loadContextStatus();
            });
        }
        if (allVars && !allVars.dataset.bound) {
            allVars.dataset.bound = '1';
            allVars.checked = this.projectContextAllVariables();
            allVars.addEventListener('change', () => {
                localStorage.setItem('projectContextAllVariables', allVars.checked ? 'true' : 'false');
                if (this.projectContextAllowed()) this.refreshContext();
            });
        }
        if (refresh && !refresh.dataset.bound) {
            refresh.dataset.bound = '1';
            refresh.addEventListener('click', () => this.refreshContext());
        }
        if (detail && !detail.dataset.bound) {
            detail.dataset.bound = '1';
            detail.addEventListener('click', () => this.toggleContextDetail());
        }
        if (!this.projectContextAllowed()) this.updateContextBar({ enabled: false });
        else this.loadContextStatus();
    },

    knowledgeContextSuffix(knowledgeStatus) {
        if (!knowledgeStatus || knowledgeStatus.enabled === false) return '';
        if (knowledgeStatus.error) return ' · 知识库加载失败';
        const count = Array.isArray(knowledgeStatus.matches) ? knowledgeStatus.matches.length : 0;
        const tokens = knowledgeStatus.tokenEstimate || 0;
        if (!tokens) return count ? ` · 知识库 ${count} 条` : ' · 知识库未命中';
        return ` · 知识库 ${count} 条 / ${tokens} token`;
    },

    updateContextBar(status, knowledgeStatus = null) {
        const led = document.getElementById('ctxLed');
        const text = document.getElementById('ctxText');
        if (!led || !text) return;
        const knowledge = this.knowledgeContextSuffix(knowledgeStatus);

        if (status.enabled === false) {
            led.className = 'tia-led is-idle';
            text.textContent = '工程上下文未发送给 AI' + knowledge;
        } else if (status.connected) {
            led.className = 'tia-led is-ok';
            const vars = status.totalVars || status.variableCount || 0;
            const chars = status.charCount ? ` · ${status.charCount} 字` : '';
            text.textContent = `已连接 ${status.project || '当前工程'} · ${status.blockCount || 0} 个块 · ${vars} 个变量${chars}${knowledge}`;
        } else {
            led.className = 'tia-led is-idle';
            text.textContent = '未连接博途 —— AI 将给出通用示例，地址需自行调整' + knowledge;
        }
    },

    async loadContextStatus() {
        try {
            const r = await fetch('/api/chat/context', {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            const j = await r.json();
            if (j.success && j.context) this.updateContextBar(j.context);
        } catch {
            this.updateContextBar({ connected: false });
        }
    },

    refreshContext() {
        const detailBox = document.getElementById('ctxDetailBox');
        if (!this.projectContextAllowed()) {
            this.updateContextBar({ enabled: false });
            return;
        }
        if (detailBox) {
            detailBox.classList.add('hidden');
            detailBox.textContent = '刷新中...';
            detailBox.classList.remove('hidden');
        }

        fetch('/api/chat/context/refresh', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify({
                forceRefresh: true,
                includeAllVariables: this.projectContextAllVariables()
            })
        }).then(r => r.json()).then(j => {
            if (j.success && j.context) {
                this.updateContextBar(j.context);
                this.lastProjectContextDetails = j.details || { prompt: j.summary || '' };
                if (detailBox) {
                    this.renderContextDetail(detailBox, this.lastProjectContextDetails || j.context);
                }
            }
        }).catch(() => {
            if (detailBox) detailBox.textContent = '刷新失败';
        });
    },

    toggleContextDetail() {
        const detailBox = document.getElementById('ctxDetailBox');
        if (!detailBox) return;

        if (detailBox.classList.contains('hidden')) {
            detailBox.classList.remove('hidden');
            detailBox.textContent = '加载中...';

            if (this.lastProjectContextDetails) {
                this.renderContextDetail(detailBox, this.lastProjectContextDetails);
                return;
            }

            fetch('/api/chat/context', {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            }).then(r => r.json()).then(j => {
                if (j.success && j.context) {
                    this.renderContextDetail(detailBox, j.context);
                } else {
                    detailBox.textContent = '暂无上下文数据';
                }
            }).catch(() => {
                detailBox.textContent = '加载失败';
            });
        } else {
            detailBox.classList.add('hidden');
        }
    },

    renderContextDetail(detailBox, payload) {
        const text = payload && (payload.prompt || payload.summary)
            ? (payload.prompt || payload.summary)
            : JSON.stringify(payload || {}, null, 2);
        detailBox.innerHTML = `<pre>${this.escapeHtml(text || '暂无上下文数据')}</pre>`;
    },

    linkKnowledgeReferences(root) {
        if (!root || !root.ownerDocument) return;
        const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                if (parent.closest('a, code, pre, .code-block')) return NodeFilter.FILTER_REJECT;
                return /《[^《》]{1,60}》/.test(node.nodeValue || '')
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT;
            }
        });
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes) {
            const fragment = root.ownerDocument.createDocumentFragment();
            const text = node.nodeValue || '';
            let last = 0;
            text.replace(/《([^《》]{1,60})》/g, (match, title, offset) => {
                if (offset > last) fragment.appendChild(root.ownerDocument.createTextNode(text.slice(last, offset)));
                const link = root.ownerDocument.createElement('a');
                link.className = 'knowledge-ref';
                link.href = `web/knowledge.html?q=${encodeURIComponent(title)}`;
                link.target = '_blank';
                link.rel = 'noopener';
                link.textContent = match;
                link.title = '打开知识库原文';
                fragment.appendChild(link);
                last = offset + match.length;
                return match;
            });
            if (last < text.length) fragment.appendChild(root.ownerDocument.createTextNode(text.slice(last)));
            node.parentNode.replaceChild(fragment, node);
        }
    }
};

document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        if (window.plcAssistant && typeof window.plcAssistant.initializeProjectContextBar === 'function') {
            window.plcAssistant.initializeProjectContextBar();
        }
        if (window.plcAssistant && typeof window.plcAssistant.loadChatHistory === 'function') {
            window.plcAssistant.loadChatHistory();
        }
    }, 0);
});
