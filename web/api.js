export const apiMethods = {
    async loadModels() {
        try {
            const token = localStorage.getItem('token');
            const resp = await fetch('/api/models', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await resp.json();
            if (!data.success || !this.modelSelect) return;
            this.modelSelect.innerHTML = '';
            if (!data.models.length) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = '无可用模型，请到设置页配置';
                this.modelSelect.appendChild(opt);
                this.modelId = '';
                localStorage.removeItem('plcModel');
                this.updateStatusbar();
                await this.loadWorkbenchStatus();
                return;
            }
            data.models.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = m.label;
                this.modelSelect.appendChild(opt);
            });
            // 服务端 currentModelId 是唯一权威来源，localStorage 只做首次渲染防闪白
            const preferred = data.currentModelId && data.models.some(m => m.id === data.currentModelId)
                ? data.currentModelId
                : null;
            if (preferred) {
                this.modelSelect.value = preferred;
                this.modelId = preferred;
            } else {
                // 服务端没有记录时，用下拉框第一个选项
                this.modelId = this.modelSelect.value;
            }
            localStorage.setItem('plcModel', this.modelId);
            this.updateStatusbar();
            await this.loadWorkbenchStatus();
        } catch (e) {
            console.error('加载模型列表失败:', e);
            await this.loadWorkbenchStatus();
        }
    },

    async persistCurrentModel(modelId) {
        if (!modelId) return;
        this.updateModelTestStatus('testing', '正在验证模型服务...');
        try {
            const token = localStorage.getItem('token');
            const resp = await fetch('/api/models/current', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ modelId })
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok || !data.success) {
                throw new Error(data.message || `HTTP ${resp.status}`);
            }
            if (data.currentModelId) {
                this.modelId = data.currentModelId;
                if (this.modelSelect) this.modelSelect.value = data.currentModelId;
                localStorage.setItem('plcModel', data.currentModelId);
            }
            this.updateStatusbar('就绪', 'is-ok');
            await this.loadWorkbenchStatus();
        } catch (e) {
            console.error('保存当前模型失败:', e);
            this.updateStatusbar('模型保存失败', 'is-warn');
            await this.loadWorkbenchStatus();
        }
    },

    async loadWorkbenchStatus() {
        try {
            const r = await fetch('/api/workbench/status', {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
            });
            const j = await r.json();
            if (j.success) {
                this.inspectorShow('system', j.status);
                this.updateModelTestStatus(
                    j.status.ai.currentModelTestStatus,
                    j.status.ai.currentModelTestMessage
                );
            } else {
                this.inspectorShow('system', null);
                this.updateModelTestStatus('unknown');
            }
        } catch (e) {
            this.inspectorShow('system', null);
            this.updateModelTestStatus('unknown');
        }
    },

    // 当前模型测试状态统一渲染：passed/failed/testing/unknown → 绿/红/黄/灰
    // 主界面状态只接受服务端 /api/workbench/status 的判定，不从 localStorage 或下拉框推导。,

    async checkQuestionLimit() {
        // 所有用户无限制提问，仅刷新状态显示
        this.updateQuestionStatus();
        return true;
    },

    checkAuthentication() {
        const token = localStorage.getItem('token');
        if (!token) {
            window.location.href = 'login.html';
            return;
        }

        fetch('/api/verify', {
            headers: { 'Authorization': `Bearer ${token}` }
        })
        .then(response => response.json())
        .then(data => {
            if (!data.success) {
                localStorage.removeItem('token');
                localStorage.removeItem('user');
                window.location.href = 'login.html';
            }
        })
        .catch(error => {
            console.error('验证令牌错误:', error);
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            window.location.href = 'login.html';
        });
    },

    loadUserInfo() {
        const user = JSON.parse(localStorage.getItem('user') || '{}');
        const tbUser = document.getElementById('tbUser');
        const tbProject = document.getElementById('tbProject');
        if (tbUser) tbUser.textContent = user.username || '—';
        if (tbProject) tbProject.textContent = '项目1';
    },

    async updateQuestionStatus() {
        return true;
    },

    async clearChat() {
        if (this.isResponding) return;
        const token = localStorage.getItem('token');
        try {
            await fetch('/api/chat/clear', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
        } catch (e) { /* 忽略 */ }
        this.messagesContainer.innerHTML = '';
        this.addAssistantMessage('对话已清空。我是老殷工控PLC编程助手，请开始提问。');
    },

    logout() {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = 'login.html';
    },
};
