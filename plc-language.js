(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlcLanguage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const SERIES = ['s200smart', 's1200', 's1500'];
    const LANGS = ['lad', 'fbd', 'scl', 'stl', 'graph'];
    const SERIES_LABELS = {
        s200smart: 'S7-200 SMART',
        s1200: 'S7-1200',
        s1500: 'S7-1500'
    };
    const SERIES_LANGS = {
        s200smart: ['lad', 'stl'],
        s1200: ['lad', 'fbd', 'scl', 'stl', 'graph'],
        s1500: ['lad', 'fbd', 'scl', 'stl', 'graph']
    };
    const DEFAULT_LANGS = { s200smart: 'stl', s1200: 'scl', s1500: 'scl' };
    const LABELS = {
        lad: 'LAD 梯形图',
        fbd: 'FBD 功能块图',
        scl: 'SCL 结构化文本',
        stl: 'STL 语句表',
        graph: 'GRAPH 顺序控制'
    };

    function normalizeSeries(series) {
        return SERIES.includes(series) ? series : 's1200';
    }

    function defaultLang(series) {
        return DEFAULT_LANGS[normalizeSeries(series)];
    }

    function availableLangs(series) {
        return SERIES_LANGS[normalizeSeries(series)].slice();
    }

    function normalizeLang(series, lang) {
        const normalizedSeries = normalizeSeries(series);
        const value = String(lang || '').toLowerCase();
        // 只有当前系列明确支持的语言才保留；S7-1200/1500 已允许 GRAPH。
        return availableLangs(normalizedSeries).includes(value)
            ? value
            : defaultLang(normalizedSeries);
    }

    function getPromptKey(series, lang) {
        const normalizedSeries = normalizeSeries(series);
        return `${normalizedSeries}_${normalizeLang(normalizedSeries, lang)}`;
    }

    function languageLabel(lang) {
        return LABELS[String(lang || '').toLowerCase()] || LABELS.scl;
    }

    function seriesLabel(series) {
        return SERIES_LABELS[normalizeSeries(series)] || 'S7-1200';
    }

    return {
        SERIES,
        LANGS,
        SERIES_LANGS,
        DEFAULT_LANGS,
        LABELS,
        SERIES_LABELS,
        normalizeSeries,
        defaultLang,
        availableLangs,
        normalizeLang,
        getPromptKey,
        languageLabel,
        seriesLabel
    };
});
