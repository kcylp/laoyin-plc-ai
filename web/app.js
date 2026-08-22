import { apiMethods } from './api.js';
import { chatMethods } from './chat.js';
import { codeBlockMethods } from './code-blocks.js';
import { historyMethods } from './history.js';
import { inspectorMethods } from './inspector.js';
import { onlineMethods } from './online.js';
import { statusbarMethods } from './statusbar.js';
import { treeMethods } from './tree.js';
import { copyCode, downloadXml, validateXml, sendToTia } from './tia-actions.js';

class PLCAIAssistant {
    constructor() {
        this.baseUrl = '';
        this.isResponding = false;
        this.timer = null;
        this.timerSeconds = 0;
        this.series = localStorage.getItem('plcSeries') || 's1200';
        // 老 localStorage 可能存了待开发项: s200smart / graph 一律回落(2026-08-05 定)
        if (this.series === 's200smart') this.series = 's1200';
        this.lang = PlcLanguage.normalizeLang(this.series, localStorage.getItem('plcLang'));
        if (this.lang === 'graph') this.lang = PlcLanguage.availableLangs(this.series)[0];
        // 当前模型以服务端保存值为准，localStorage 只做页面加载时的兜底。
        this.modelId = localStorage.getItem('plcModel') || '';

        this.checkAuthentication();
        this.initializeElements();
        this.bindEvents();
        this.loadUserInfo();
        this.applySeriesUI();
        this.renderProjectTree();
        this.loadModels();
    }
}

Object.assign(PLCAIAssistant.prototype,
    apiMethods,
    chatMethods,
    codeBlockMethods,
    historyMethods,
    inspectorMethods,
    onlineMethods,
    statusbarMethods,
    treeMethods
);

window.copyCode = copyCode;
window.downloadXml = downloadXml;
window.validateXml = validateXml;
window.sendToTia = sendToTia;

document.addEventListener('DOMContentLoaded', () => {
    window.plcAssistant = new PLCAIAssistant();
});

export { PLCAIAssistant };
