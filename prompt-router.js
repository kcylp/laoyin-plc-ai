// ============================================================
// 老殷工控PLC - system prompt 路由
// 按 系列×语言 解析提示词键，回退链：
//   {series}_{lang}（归一化后） → {series}（旧版键） → s1200_scl（全局兜底）
// 语言归一化统一走 plc-language.js，避免各调用方重复实现。
// ============================================================

const PlcLanguage = require('./plc-language');

// 归一化后的提示词键：如 s1200 + scl -> s1200_scl；s200smart + scl -> s200smart_stl
function resolvePromptKey(series, lang) {
    return PlcLanguage.getPromptKey(series, lang);
}

// 取提示词内容：系列×语言键缺失时不能回退到另一种语言，
// 否则用户选择 GRAPH 等语言时会得到 SCL 内容并被误标为已支持。
function resolvePromptContent(prompts, series, lang) {
    const key = resolvePromptKey(series, lang);
    return prompts[key] || '';
}

module.exports = { resolvePromptKey, resolvePromptContent };
