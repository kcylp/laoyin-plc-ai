import { confirmDialog } from './confirm-dialog.js';
import { outputPanel } from './output-panel.js';

function headers() {
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') };
}

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, function (ch) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
}

async function postJson(url, body) {
    const response = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    return { response, json: await response.json().catch(function () { return null; }) };
}

function deviceTitle(item) {
    return item.typeName || item.description || item.articleNumber || item.typeIdentifier || item.catalogPath || '硬件设备';
}

function deviceFamily(item) {
    const text = [item.typeName, item.description, item.catalogPath, item.articleNumber, item.typeIdentifier].filter(Boolean).join(' ').toLowerCase();
    if (/wincc|unified|hmi|ktp|mtp|tp\d/.test(text)) return 'WinCCUnifiedPC';
    if (/s7[-\s]?1200|12(?:1|2|4|5|7)\d/.test(text)) return 'S7-1200';
    return 'S7-1500';
}

function deviceProjectName(item, family) {
    const prefix = family === 'WinCCUnifiedPC' ? 'HMI' : 'PLC';
    const raw = item.articleNumber || item.typeName || item.description || 'Device';
    const suffix = String(raw).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'Device';
    return prefix + '_' + suffix;
}

function renderHardware(list, items) {
    if (!list) return;
    if (!items.length) {
        list.innerHTML = '<div class="hist-empty">没有硬件目录结果</div>';
        return;
    }
    list.innerHTML = items.map(function (item, index) {
        const title = deviceTitle(item);
        const meta = [item.articleNumber, item.version, item.catalogPath].filter(Boolean).join(' · ');
        return '<div class="online-result-item">' +
            '<div><b>' + esc(title) + '</b><span>' + esc(meta || item.typeIdentifier || '') + '</span></div>' +
            '<button class="tia-btn is-ghost is-sm" type="button" data-add-hardware="' + index + '">添加</button>' +
            '</div>';
    }).join('');
}

function normalizeTables(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.tables)) return payload.tables;
    if (payload && Array.isArray(payload.Items)) return payload.Items;
    if (payload && Array.isArray(payload.items)) return payload.items;
    return [];
}

function tableName(item) {
    if (typeof item === 'string') return item;
    return item && (item.name || item.Name || item.path || item.Path || item.title || item.Title) || '变量表';
}

export const hardwarePanel = {
    init({ app } = {}) {
        const root = document.getElementById('hardwarePanel');
        const tagRoot = document.getElementById('tagTablePanel');
        if (root && root.dataset.bound !== '1') {
            root.dataset.bound = '1';
            this.bindHardware(root);
        }
        if (tagRoot && tagRoot.dataset.bound !== '1') {
            tagRoot.dataset.bound = '1';
            this.bindTagTables(tagRoot, app);
        }
    },

    bindHardware(root) {
        const keyword = document.getElementById('hardwareKeyword');
        const searchBtn = document.getElementById('hardwareSearchBtn');
        const list = document.getElementById('hardwareResults');
        let items = [];
        if (!searchBtn || !keyword) return;
        searchBtn.addEventListener('click', async function () {
            const value = keyword.value.trim();
            if (!value) {
                outputPanel.push({ kind: 'error', title: '硬件搜索', body: '请输入 MLFB/设备关键字' });
                return;
            }
            searchBtn.disabled = true;
            if (list) list.innerHTML = '<div class="hist-empty">搜索硬件目录中…</div>';
            try {
                const { response, json } = await postJson('/api/tia/mcp/search-hardware', { keyword: value, limit: 50 });
                items = json && Array.isArray(json.items) ? json.items : [];
                renderHardware(list, items);
                outputPanel.push({ kind: json && json.success ? 'success' : 'error', title: '硬件目录搜索', body: json && json.success ? ('找到 ' + items.length + ' 条候选') : ((json && json.message) || String(response.status)), detail: json });
            } catch (error) {
                if (list) list.innerHTML = '<div class="hist-empty">硬件搜索异常:' + esc(error.message) + '</div>';
                outputPanel.push({ kind: 'error', title: '硬件搜索异常', body: error.message });
            } finally {
                searchBtn.disabled = false;
            }
        });
        if (list) list.addEventListener('click', async function (event) {
            const btn = event.target.closest('[data-add-hardware]');
            if (!btn) return;
            const item = items[Number(btn.dataset.addHardware)];
            if (!item) return;
            const title = deviceTitle(item);
            const family = deviceFamily(item);
            const deviceName = deviceProjectName(item, family);
            const decision = await confirmDialog({
                level: 'warn',
                title: '添加硬件设备',
                facts: [
                    { k: '设备', v: title },
                    { k: '订货号', v: item.articleNumber || '—' },
                    { k: '系列', v: family },
                    { k: '工程设备名', v: deviceName }
                ],
                warning: '将通过 AddDeviceWithFallback 修改当前 TIA 工程硬件组态。',
                requireCheck: '我已确认当前工程可修改',
                confirmText: '添加设备'
            });
            if (!decision) return;
            btn.disabled = true;
            try {
                const args = {
                    preferredMlfb: item.articleNumber || item.typeIdentifierNormalized || item.typeIdentifier || '',
                    preferredVersion: item.version || '',
                    deviceName: deviceName,
                    family: family
                };
                const { response, json } = await postJson('/api/tia/mcp/call', { name: 'AddDeviceWithFallback', args, timeoutMs: 180000, confirmed: true });
                outputPanel.push({ kind: json && json.success ? 'success' : 'error', title: '添加硬件结果', body: json && json.success ? JSON.stringify(json.json || json.text || json, null, 2) : ((json && json.message) || String(response.status)), detail: json });
            } catch (error) {
                outputPanel.push({ kind: 'error', title: '添加硬件异常', body: error.message });
            } finally {
                btn.disabled = false;
            }
        });
    },

    bindTagTables(root, app) {
        const refresh = document.getElementById('tagTablesRefresh');
        const list = document.getElementById('tagTablesList');
        if (!refresh || !list) return;
        refresh.addEventListener('click', async function () {
            refresh.disabled = true;
            list.innerHTML = '<div class="hist-empty">读取变量表中…</div>';
            try {
                const { response, json } = await postJson('/api/tia/mcp/tag-tables', { softwarePath: 'PLC_1' });
                if (!response.ok || !json || !json.success || json.connected === false) {
                    const message = json && json.message ? json.message : ('HTTP ' + response.status);
                    list.innerHTML = '<div class="hist-empty">变量表读取失败：' + esc(message) + '</div>';
                    outputPanel.push({ kind: 'error', title: '变量表列表', body: message, detail: json });
                    return;
                }
                const tables = normalizeTables(json && (json.tables || json.json || json));
                list.innerHTML = tables.length ? tables.map(function (item, index) {
                    return '<button class="online-result-item is-button" type="button" data-tag-table="' + index + '"><b>' + esc(tableName(item)) + '</b><span>点击在右栏查看</span></button>';
                }).join('') : '<div class="hist-empty">当前 PLC 软件下没有变量表</div>';
                list.querySelectorAll('[data-tag-table]').forEach(function (btn) {
                    btn.addEventListener('click', function () {
                        const item = tables[Number(btn.dataset.tagTable)];
                        if (app && typeof app.inspectorShow === 'function') app.inspectorShow('tag-table', { name: tableName(item), item, raw: json });
                    });
                });
                outputPanel.push({ kind: json && json.success ? 'success' : 'error', title: '变量表列表', body: json && json.success ? ('读取 ' + tables.length + ' 个变量表') : ((json && json.message) || String(response.status)), detail: json });
            } catch (error) {
                list.innerHTML = '<div class="hist-empty">变量表读取异常:' + esc(error.message) + '</div>';
                outputPanel.push({ kind: 'error', title: '变量表读取异常', body: error.message });
            } finally {
                refresh.disabled = false;
            }
        });
    }
};
