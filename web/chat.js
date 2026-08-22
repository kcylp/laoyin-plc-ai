import { detectLanguageIntent } from './code-blocks.js';
import { confirmDialog } from './confirm-dialog.js';
import { outputPanel } from './output-panel.js';

export const chatMethods = {
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

        // 检查是否 PLC 相关问题
        if (!this.isPLCRelated(message)) {
            this.addUserMessage(message);
            this.addAssistantMessage('抱歉，我是专业的PLC编程助手，专注于西门子 S7-200 SMART/1200/1500 的编程。请咨询梯形图、SCL、STL、定时器、计数器、通信等相关问题。');
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

    isPLCRelated(message) {
        const plcKeywords = [
            'PLC', 'plc', '可编程逻辑控制器', '可编程控制器',
            '梯形图', '指令表', '功能块', 'FB', 'FC', 'OB', 'DB',
            '西门子', 'SIEMENS', '三菱', 'MITSUBISHI', '欧姆龙', 'OMRON',
            'Step7', 'TIA', '博途', 'SMART', 'S7-200', 'S7-1200', 'S7-1500',
            '模拟量', '数字量', 'IO', 'I/O', '输入输出', 'AIW', 'AQW',
            '传感器', '执行器', '变频器', '触摸屏', 'HMI',
            '通信', '以太网', 'Profibus', 'Profinet', 'Modbus', 'OPC',
            '程序', '编程', '逻辑', '控制', '自动化', '代码',
            '定时器', '计数器', '比较', '运算', 'TON', 'TOF', 'TP', 'CTU',
            'LD', 'LDI', 'AND', 'ANI', 'OR', 'ORI', 'OUT', 'SET', 'RST',
            'MOV', 'ADD', 'SUB', 'MUL', 'DIV', 'CMP', 'SCL', 'STL', 'LAD', 'FBD',
            '工业', '自动化', '控制系统', '生产线', '电机', '起保停', '星三角',
            '变量', '数据块', '主程序', '子程序', '中断', 'SCL代码', '写程序',
            '梯形图代码', '程序块', 'I0.0', 'Q0.0', 'VW', 'VB', 'MW'
        ];

        return plcKeywords.some(keyword =>
            message.toLowerCase().includes(keyword.toLowerCase())
        );
    },

    // 整工程模式:与「写块进当前工程」同一个输入框,但走建工程链路:
    // 自然语言 → 我们的模型产 spec → 离线校验 → 用户点「正式建工程」才执行。,

    async sendScaffold(message) {
        this.addUserMessage(message + '（整工程）');
        this.userInput.value = '';
        this.setLoading(true);
        const pending = this.addAssistantMessage('', true);
        try {
            const r = await fetch('/api/tia/mcp/scaffold', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ requirement: message }),
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
                    resultDiv.innerHTML = '<p>正在建工程（可能需要数分钟）…</p>';
                    try {
                        const rr = await fetch('/api/tia/mcp/scaffold', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                            body: JSON.stringify({ spec: j.spec, confirmed: true }),
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
                        resultDiv.innerHTML = `<p style="color:var(--tia-err)">建工程异常:${this.escapeHtml(e.message)}</p>`;
                        outputPanel.push({ kind: 'error', title: '建工程正式报告异常', body: e.message });
                        runBtn.disabled = false;
                        return;
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
            pending.innerHTML = `<p style="color:var(--tia-err)">建工程请求异常:${this.escapeHtml(e.message)}</p>`;
            outputPanel.push({ kind: 'error', title: '建工程 dryRun 异常', body: e.message });
        } finally {
            this.setLoading(false);
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

        try {
            if (!this.modelId) await this.loadModels();
            if (!this.modelId) throw new Error('当前账号没有已启用模型，请先到设置页保存所选模型');

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
                    modelId: this.modelId
                })
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
                        } else if (data.type === 'done') {
                            responseText = data.content;
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
            console.error('AI请求错误:', error);
            this.finalizeMessage(assistantMessageContent, '抱歉，请求出错：' + error.message);
        }

        this.setLoading(false);
        this.stopTimer();
    },

    updateStreamingMessage(element, text) {
        element.innerHTML = this.formatMessage(text, true) + '<span class="typing-cursor"></span>';
        this.scrollToBottom();
    },

    // 格式化为 HTML，识别代码块，并提供复制/下载
    // 注意：先保护代码块内容，避免后续换行/加粗替换污染 XML,

    finalizeMessage(element, text) {
        element.innerHTML = this.formatMessage(text);
        this.addTreeBlocks(text, element.closest('.message'));
        this.scrollToBottom();
    },
};
