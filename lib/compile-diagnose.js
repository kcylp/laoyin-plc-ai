const DEFAULT_COMPILE_LOOP_LIMITS = Object.freeze({
    maxTokens: 100000,
    maxRepairRounds: 5,
});

const DEFAULT_COMPILE_LOOP_SETTINGS = Object.freeze({
    autoRepair: false,
    ...DEFAULT_COMPILE_LOOP_LIMITS,
    skipRepairConfirmations: false,
});

const DIAGNOSIS_RULES = [
    {
        type: 'encoding-garbled',
        test: (text) => /[\uE000-\uF8FF]|(?:鍚|姩|乱码|mojibake)/i.test(text),
        rootCause: '变量名存在编码乱码，源文本的字节编码与博途读取编码不一致。',
        suggestion: '从生成源头统一使用 UTF-8，并把变量名改为可稳定往返的英文标识符；不要对乱码文本做猜测性替换。',
        auto: true,
    },
    {
        type: 'tag-not-defined',
        test: (text) => /Tag\s+".*?"\s+not defined|undefined\s+(?:tag|variable)|未定义(?:变量|标签)/i.test(text),
        rootCause: '变量或标签未定义，引用名与块接口、局部变量表或 PLC 标签表不一致。',
        suggestion: '核对变量表和块接口中的名称、作用域及大小写，再修正引用。',
        auto: true,
    },
    {
        type: 'type-mismatch',
        test: (text) => /type mismatch|cannot convert|incompatible type|类型不匹配|无法转换/i.test(text),
        rootCause: '操作数或赋值两侧类型不匹配；IEC 检查属性会影响部分转换是否允许。',
        suggestion: '先查块的 IEC 检查属性，再按目标类型添加显式转换或修正接口类型。',
        auto: true,
    },
    {
        type: 'missing-local-prefix',
        test: (text) => /is not supported by the CPU or library version/i.test(text) && !/\b(?:MC_|TO_|instruction)\b/i.test(text),
        rootCause: 'SCL 局部变量引用可能漏写 # 前缀，博途因而把名称当作指令或全局符号解析。',
        suggestion: '对块接口和局部变量引用补齐 # 前缀，然后重新编译。',
        auto: true,
    },
    {
        type: 'interface-mismatch',
        test: (text) => /interface mismatch|formal parameter|actual parameter|块接口|形参|实参/i.test(text),
        rootCause: '块接口与调用点不一致，参数名称、方向或数据类型已经发生变化。',
        suggestion: '对照 IN、OUT、INOUT、STAT 接口清单更新调用点，并检查实例 DB。',
        auto: true,
    },
    {
        type: 'cpu-unsupported',
        test: (text) => /not supported by the CPU|CPU.*(?:不支持|unsupported)|instruction.*not supported/i.test(text),
        rootCause: '当前 CPU 或固件不支持该指令、工艺对象或库版本。',
        suggestion: '核对工程 CPU 型号、固件和指令版本，改用该平台支持的等价指令。',
        auto: false,
    },
    {
        type: 'uid-conflict',
        test: (text) => /duplicate\s+UID|UID.*(?:already exists|conflict|重复|冲突)/i.test(text),
        rootCause: 'SimaticML 网络中存在 UID 冲突或重复编号。',
        suggestion: '重新分配冲突对象及其连线引用的 UID，并保持网络内唯一。',
        auto: true,
    },
];

function positiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveCompileLoopLimits(input = {}) {
    return {
        maxTokens: positiveInt(input.maxTokens, DEFAULT_COMPILE_LOOP_LIMITS.maxTokens),
        maxRepairRounds: positiveInt(input.maxRepairRounds, DEFAULT_COMPILE_LOOP_LIMITS.maxRepairRounds),
    };
}

function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 3);
}

function extractRepairCode(text) {
    const source = String(text || '').trim();
    const fenced = /```(?:scl|stl|xml|lad|fbd)?\s*\r?\n([\s\S]*?)\r?\n```/i.exec(source);
    return (fenced ? fenced[1] : source).trim();
}

function parsePosition(text) {
    const block = /(?:Path|Block|BlockName)\s*[=:]\s*([^\s,;]+)/i.exec(text);
    const network = /Network\s*[=:]?\s*(\d+)/i.exec(text);
    const line = /(?:Line|line number)\s*[=:]?\s*(\d+)/i.exec(text);
    const code = /\b([A-Z][A-Z0-9_]*_\d+[A-Z]?|(?:16#)?[0-9A-F]{4,})\s*:/i.exec(text);
    return {
        blockName: block ? block[1] : '',
        network: network ? Number.parseInt(network[1], 10) : 0,
        line: line ? Number.parseInt(line[1], 10) : 0,
        code: code ? code[1] : '',
    };
}

function diagnoseCompileResult(result = {}) {
    const messages = Array.isArray(result.messages) ? result.messages : [];
    return messages.map((raw) => {
        const message = String(raw);
        const rule = DIAGNOSIS_RULES.find((candidate) => candidate.test(message)) || {
            type: 'unknown',
            rootCause: '博途返回了尚未归类的编译错误。',
            suggestion: '保留完整错误原文并结合行号、网络号和块名人工定位。',
            auto: false,
        };
        return {
            type: rule.type,
            severity: /^\s*warning/i.test(message) ? 'warning' : 'error',
            ...parsePosition(message),
            message,
            '中文根因': rule.rootCause,
            '修复建议': rule.suggestion,
            '可自动修复': rule.auto,
        };
    });
}

function sameErrors(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => String(item) === String(right[index]));
}

function evaluateCompileLoop(state = {}, limitInput = {}) {
    const limits = resolveCompileLoopLimits(limitInput);
    const rawErrors = Array.isArray(state.rawErrors) ? [...state.rawErrors] : [];
    const base = {
        stop: false,
        stopReason: '',
        message: '',
        repairRound: Number(state.repairRound || 0),
        tokenUsed: Number(state.tokenUsed || 0),
        lastCode: String(state.lastCode || ''),
        rawErrors,
        limits,
    };

    if (base.tokenUsed >= limits.maxTokens) {
        return { ...base, stop: true, stopReason: 'token-limit', message: `已达到 ${limits.maxTokens.toLocaleString('en-US')} token 上限，自动修复已停止。` };
    }
    if (base.repairRound >= limits.maxRepairRounds) {
        return { ...base, stop: true, stopReason: 'round-limit', message: `已达到 ${limits.maxRepairRounds} 轮自动修复上限，自动修复已停止。` };
    }
    if (base.repairRound > 0 && sameErrors(rawErrors, state.previousRawErrors)) {
        return { ...base, stop: true, stopReason: 'same-errors', message: '连续两轮编译错误完全相同，自动修复已停止。' };
    }
    return base;
}

module.exports = {
    DEFAULT_COMPILE_LOOP_LIMITS,
    DEFAULT_COMPILE_LOOP_SETTINGS,
    diagnoseCompileResult,
    estimateTokens,
    evaluateCompileLoop,
    extractRepairCode,
    resolveCompileLoopLimits,
};
