(function (root, factory) {
    const language = root && root.PlcLanguage
        || (typeof require === 'function' ? require('./plc-language') : null);
    const api = factory(language);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TiaConfirmation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (language) {
    const fallbackLabel = (value) => String(value || '').toUpperCase();
    const getLabel = language && language.languageLabel
        ? language.languageLabel
        : fallbackLabel;

    function buildTiaConfirmation(preflight) {
        const data = preflight || {};
        const name = data.blockName || '-';
        const nameTaken = data.nameTaken === true;
        return {
            tiaVersion: data.tiaVersion ? 'TIA ' + data.tiaVersion : '博途',
            project: data.project || '-',
            plc: data.plc || '-',
            blockType: data.blockType || '-',
            blockName: name,
            language: getLabel(data.language),
            existingCount: data.existingCount == null ? '-' : String(data.existingCount),
            warning: nameTaken ? `项目里已经有同名块「${name}」，继续会覆盖它，原内容将被替换。` : '',
            overwrite: false
        };
    }

    return { buildTiaConfirmation };
});
