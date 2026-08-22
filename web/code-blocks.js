function detectLanguageIntent(message) {
    const text = String(message || '');
    // GRAPH 不参与：本平台暂不支持写入 GRAPH，切过去只会让用户拿不到可写入的结果
    const patterns = {
        lad: /梯形图|梯型图|LAD\b/i,
        fbd: /功能块图|逻辑框图|FBD\b/i,
        scl: /\bSCL\b|结构化文本/i,
        stl: /\bSTL\b|语句表|指令表/i
    };
    const hits = Object.keys(patterns).filter(key => patterns[key].test(text));
    return hits.length === 1 ? hits[0] : null;
}

// 补齐未闭合围栏时留下的内部标记：仅用于判定「模型仍在输出」，渲染前剥掉。
// 用不可见字符，避免与正文内容碰撞。
const UNCLOSED_FENCE_MARK = '​​UNCLOSED​​';

// 源码能否作为 SCL/STL 写入博途：必须是完整的块声明 + 配对的 END 标记。
// 缺声明（只有 VAR_INPUT 片段）或缺 END（流式输出未完成）都会让博途编译失败，
// 那种情况下不能给出「发送至博途」按钮。
function classifySourcePayload(code) {
    const text = String(code || '');
    const decl = /(?:^|\n)[^\S\r\n]*(FUNCTION_BLOCK|FUNCTION|DATA_BLOCK|ORGANIZATION_BLOCK)\b/i.exec(text);
    if (!decl) return { ok: false, reason: 'no-decl' };

    const kw = decl[1].toUpperCase();
    // FUNCTION 声明后必须跟块名，避免把 END_FUNCTION_BLOCK 里的片段当成声明
    const endRe = new RegExp(`(?:^|\\n)[^\\S\\r\\n]*END_${kw}\\b`, 'i');
    if (!endRe.test(text)) return { ok: false, reason: 'no-end' };
    return { ok: true };
}

function normalizeCodeFenceBalance(text) {
    const source = String(text || '');
    const fences = [...source.matchAll(/```[a-zA-Z]*[^\S\r\n]*(?:\r?\n)?/g)];
    if (!fences.length || fences.length % 2 === 0) return source;

    const lastFence = fences[fences.length - 1];
    const tail = source.slice(lastFence.index + lastFence[0].length);
    if (!tail.trim()) return source;
    // 标记这段是补齐的：未闭合围栏说明模型还在输出，源码不可写入
    return source.replace(/\s*$/, '') + '\n```' + UNCLOSED_FENCE_MARK;
}

function scrubVisibleAssistantText(text) {
    const source = String(text || '');
    const scrub = (part) => part.replace(/Eigen(?:\s+Engineering\s+Agent|\s+Agent)?|CC\s*Switch|ccswitch/gi, '工程智能体');
    if (!/```/.test(source)) return scrub(source);

    const codeBlocks = [];
    const protectedText = source.replace(/```[a-zA-Z]*\n?[\s\S]*?```/g, (block) => {
        const idx = codeBlocks.length;
        codeBlocks.push(block);
        return `@@PROTECTED_CODE_${idx}@@`;
    });
    return scrub(protectedText).replace(/@@PROTECTED_CODE_(\d+)@@/g, (_, idx) => codeBlocks[parseInt(idx, 10)] || '');
}

function normalizeUnfencedPlcCode(text, isStreaming = false) {
    const source = String(text || '');
    if (!source || /```/.test(source)) return source;

    const xmlRange = findXmlDocumentRange(source);
    if (xmlRange) return wrapCodeRange(source, xmlRange.start, xmlRange.end, 'xml');

    const encodedXmlRange = findEncodedXmlDocumentRange(source);
    if (encodedXmlRange) return wrapCodeRange(source, encodedXmlRange.start, encodedXmlRange.end, 'xml', decodeHtmlEncodedXml);

    const sclRange = findSclRange(source, isStreaming);
    if (sclRange) return wrapCodeRange(source, sclRange.start, sclRange.end, 'scl');

    const stlRange = findStlRange(source, isStreaming);
    if (stlRange) return wrapCodeRange(source, stlRange.start, stlRange.end, 'stl');

    return source;
}

function wrapCodeRange(source, start, end, lang, transformCode) {
    const before = source.slice(0, start).trimEnd();
    const rawCode = source.slice(start, end).trim();
    const code = typeof transformCode === 'function' ? transformCode(rawCode) : rawCode;
    const after = source.slice(end).trimStart();
    if (!code) return source;
    return [before, '```' + lang + '\n' + code + '\n```', after].filter(Boolean).join('\n');
}

function findXmlDocumentRange(source) {
    const doc = /<Document[\s>]/i.exec(source);
    if (!doc) return null;

    const xmlDecl = /<\?xml[\s\S]*?\?>\s*/i.exec(source);
    const start = xmlDecl && xmlDecl.index <= doc.index ? xmlDecl.index : doc.index;
    const close = /<\/Document>\s*/i.exec(source.slice(doc.index));
    if (!close) return null;

    return { start, end: doc.index + close.index + close[0].length };
}

function findEncodedXmlDocumentRange(source) {
    const doc = /&lt;Document(?:\s|&gt;)/i.exec(source);
    if (!doc) return null;

    const decl = /&lt;\?xml[\s\S]*?\?&gt;\s*/i.exec(source);
    const start = decl && decl.index <= doc.index ? decl.index : doc.index;
    const close = /&lt;\/Document&gt;\s*/i.exec(source.slice(doc.index));
    if (!close) return null;

    return { start, end: doc.index + close.index + close[0].length };
}

function looksLikeEncodedXml(text) {
    return /&lt;Document(?:\s|&gt;)/i.test(String(text || '')) && /&lt;\/Document&gt;/i.test(String(text || ''));
}

function decodeHtmlEncodedXml(text) {
    return String(text || '')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&amp;/gi, '&');
}

function getLineRanges(source) {
    const lines = [];
    let offset = 0;
    for (const match of source.matchAll(/.*(?:\r?\n|$)/g)) {
        const raw = match[0];
        if (!raw) continue;
        const start = offset;
        const end = offset + raw.length;
        lines.push({ raw, text: raw.replace(/\r?\n$/, ''), start, end });
        offset = end;
    }
    return lines;
}

function findSclRange(source, isStreaming = false) {
    const lines = getLineRanges(source);
    const startIndex = lines.findIndex(line => isSclStartLine(line.text));
    if (startIndex < 0) return null;

    const blockStart = /^(FUNCTION_BLOCK|FUNCTION(?!_)|DATA_BLOCK|ORGANIZATION_BLOCK)\b/i.exec(lines[startIndex].text.trim());
    const endToken = blockStart ? {
        FUNCTION_BLOCK: 'END_FUNCTION_BLOCK',
        FUNCTION: 'END_FUNCTION',
        DATA_BLOCK: 'END_DATA_BLOCK',
        ORGANIZATION_BLOCK: 'END_ORGANIZATION_BLOCK'
    }[blockStart[1].toUpperCase()] : null;

    let endIndex = -1;
    let controlEndIndex = -1;
    for (let i = startIndex; i < lines.length; i++) {
        const trimmed = lines[i].text.trim();
        if (endToken && new RegExp('^' + endToken + '\\s*;?$', 'i').test(trimmed)) {
            endIndex = i;
            break;
        }
        if (!endToken && /^END_(FUNCTION_BLOCK|FUNCTION|DATA_BLOCK|ORGANIZATION_BLOCK)\s*;?$/i.test(trimmed)) {
            endIndex = i;
            break;
        }
        if (!endToken && /^END_(IF|CASE|FOR|WHILE|REPEAT)\s*;?$/i.test(trimmed)) {
            controlEndIndex = i;
        }
    }

    if (endIndex < 0 && controlEndIndex >= 0) {
        endIndex = controlEndIndex;
    }

    if (endIndex < 0) {
        endIndex = findStreamingCodeTail(lines, startIndex, isSclEvidenceLine);
        if (endIndex < 0) return null;
        if (!isStreaming && !blockStart) return null;
    }

    const evidence = lines.slice(startIndex, endIndex + 1).filter(line => isSclEvidenceLine(line.text)).length;
    if (evidence < 3) return null;
    return { start: lines[startIndex].start, end: lines[endIndex].end };
}

function isSclStartLine(text) {
    const trimmed = String(text || '').trim();
    return /^(FUNCTION_BLOCK|FUNCTION(?!_)|DATA_BLOCK|ORGANIZATION_BLOCK|VAR(?:_INPUT|_OUTPUT|_IN_OUT|_TEMP)?|BEGIN|IF\b.+\bTHEN\b|CASE\b|FOR\b.+\bDO\b|WHILE\b.+\bDO\b|REPEAT\b)/i.test(trimmed)
        || /^#?[A-Za-z_][\w\u4e00-\u9fa5]*\s*:=/.test(trimmed);
}

function isSclEvidenceLine(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    return /^(FUNCTION_BLOCK|FUNCTION(?!_)|DATA_BLOCK|ORGANIZATION_BLOCK|VAR(?:_INPUT|_OUTPUT|_IN_OUT|_TEMP)?|END_VAR|BEGIN|END_(FUNCTION_BLOCK|FUNCTION|DATA_BLOCK|ORGANIZATION_BLOCK|IF|CASE|FOR|WHILE|REPEAT)|IF\b|ELSIF\b|ELSE\b|CASE\b|FOR\b|WHILE\b|REPEAT\b)/i.test(trimmed)
        || /^\{\s*S7_Optimized_Access\s*:=/i.test(trimmed)
        || /^VERSION\s*:\s*[\d.]+\s*;?$/i.test(trimmed)
        || /^\/\//.test(trimmed)
        || /^\(\*/.test(trimmed)
        || /^#?[A-Za-z_][\w\u4e00-\u9fa5]*\s*:=/.test(trimmed)
        || /^[A-Za-z_][\w\u4e00-\u9fa5]*\s*:\s*(Array\b|Bool\b|Byte\b|Word\b|DWord\b|Int\b|DInt\b|LInt\b|Real\b|LReal\b|Time\b|LTime\b|String\b|TON_TIME\b)/i.test(trimmed)
        || /;\s*(?:\/\/.*)?$/.test(trimmed);
}

function findStlRange(source, isStreaming = false) {
    const lines = getLineRanges(source);
    const startIndex = lines.findIndex(line => isStlEvidenceLine(line.text));
    if (startIndex < 0) return null;

    let endIndex = startIndex;
    for (let i = startIndex; i < lines.length; i++) {
        const trimmed = lines[i].text.trim();
        if (!trimmed) {
            if (!isStreaming) break;
            continue;
        }
        if (!isStlEvidenceLine(trimmed) && !/^\/\//.test(trimmed)) break;
        endIndex = i;
    }

    const evidence = lines.slice(startIndex, endIndex + 1).filter(line => isStlEvidenceLine(line.text)).length;
    if (evidence < 3) return null;
    return { start: lines[startIndex].start, end: lines[endIndex].end };
}

function isStlEvidenceLine(text) {
    const trimmed = String(text || '').trim();
    return /^(NETWORK|TITLE|CALL|A|AN|O|ON|X|XN|=|S|R|L|T|JU|JC|JCN|NOP)\b/i.test(trimmed);
}

function findStreamingCodeTail(lines, startIndex, isEvidenceLine) {
    let endIndex = -1;
    let evidence = 0;
    for (let i = startIndex; i < lines.length; i++) {
        const trimmed = lines[i].text.trim();
        if (!trimmed) continue;
        if (!isEvidenceLine(trimmed)) break;
        evidence++;
        endIndex = i;
    }
    return evidence >= 3 ? endIndex : -1;
}

// 识别代码块类型：xml 的 lad/fbd/scl/stl/graph/unknown，或纯文本。
// 完整 <Document> 没有直接语言根节点时，回退读 <ProgrammingLanguage> 声明。
function identifyCodeType(code) {
    if (/<Document[\s>]/i.test(code)) {
        const m = code.match(/<(?:[A-Za-z_][\w.-]*:)?ProgrammingLanguage(?:\s[^>]*)?>([^<]+)<\/(?:[A-Za-z_][\w.-]*:)?ProgrammingLanguage>/i);
        const lang = m ? m[1].trim().toLowerCase() : 'unknown';
        const known = { lad: 'lad', fbd: 'fbd', scl: 'scl', stl: 'stl', graph: 'graph' };
        if (known[lang]) return { type: 'xml', lang: known[lang] };
    }
    if (/<FlgNet[\s>]/i.test(code)) return { type: 'xml', lang: 'lad' };
    if (/<StructuredText[\s>]/i.test(code)) return { type: 'xml', lang: 'scl' };
    if (/<StatementList[\s>]/i.test(code)) return { type: 'xml', lang: 'stl' };
    if (/<Graph[\s>]/i.test(code)) return { type: 'xml', lang: 'graph' };
    if (/<Document[\s>]/i.test(code)) return { type: 'xml', lang: 'unknown' };
    return { type: 'text', lang: null };
}

// 复制代码

export const codeBlockMethods = {
    formatMessage(text, isStreaming = false) {
        text = normalizeCodeFenceBalance(text);
        // 围栏是补齐的 → 模型还在输出，源码不完整，不给写入按钮
        const fenceWasUnclosed = text.includes(UNCLOSED_FENCE_MARK);
        if (fenceWasUnclosed) text = text.split(UNCLOSED_FENCE_MARK).join('');
        text = normalizeUnfencedPlcCode(text, isStreaming);
        text = scrubVisibleAssistantText(text);
        const trimmed = String(text || '').trim();
        if (!/```/.test(text) && /^<[\s\S]+>$/.test(trimmed) && identifyCodeType(trimmed).type === 'xml') {
            text = '```xml\n' + trimmed + '\n```';
        }
        const escaped = this.escapeHtml(text);
        const codeBlocks = [];
        // 原始（未转义）代码块，仅用于类型识别：转义后的内容 < 已变 &lt;，
        // 直接对 cleanCode 识别会把所有 XML 误判成纯文本（按钮区丢失发送/校验）
        const rawBlocks = [];
        text.replace(/```([a-zA-Z]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
            rawBlocks.push(code);
            return match;
        });

        // 第一步：提取所有代码块，用占位符替换
        let formatted = escaped.replace(/```([a-zA-Z]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
            const idx = codeBlocks.length;
            codeBlocks.push({ lang, code });
            return `@@CODEBLOCK_${idx}@@`;
        });

        // 第二步：处理行内代码
        formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');

        // 第三步：处理换行、粗体、标题、列表
        formatted = formatted.replace(/\n/g, '<br>');
        formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        formatted = formatted.replace(/^#{3}\s+(.*)$/gm, '<h4>$1</h4>');
        formatted = formatted.replace(/^##\s+(.*)$/gm, '<h3>$1</h3>');
        formatted = formatted.replace(/^[-*]\s+(.*)$/gm, '<li>$1</li>');

        // 第四步：把代码块占位符替换回完整 HTML（此时不会再被全局替换污染）
        formatted = formatted.replace(/@@CODEBLOCK_(\d+)@@/g, (match, idx) => {
            const { lang, code } = codeBlocks[parseInt(idx)];
            let cleanCode = code.replace(/\r?\n$/, '');
            let rawCode = (rawBlocks[parseInt(idx)] || '').replace(/\r?\n$/, '');
            if (/xml/i.test(lang) && looksLikeEncodedXml(rawCode)) {
                rawCode = decodeHtmlEncodedXml(rawCode);
                cleanCode = this.escapeHtml(rawCode);
            }
            const langLabel = lang ? lang.toUpperCase() : '代码';
            // 用原始内容识别类型（转义后 < 已变 &lt;，正则匹配不到）
            let detected = identifyCodeType(rawCode);
            // 兑底：围栏标了 xml 但内容识别为 text 时，按 unknown XML 处理（可下载/校验，不发送）
            if (detected.type === 'text' && /xml/i.test(lang)) {
                detected = { type: 'xml', lang: 'unknown' };
            }
            const attr = this.escapeAttr(rawCode);

            let actionBtns;
            if (detected.type === 'xml') {
                // GRAPH 原生块 XML 尚未完成模板回环验证，不开放自动写入
                const isSendable = detected.lang === 'lad' || detected.lang === 'fbd';
                const detectedLangLabel = detected.lang && detected.lang !== 'unknown'
                    ? detected.lang.toUpperCase()
                    : 'XML';
                actionBtns =
                    `<button class="code-action" onclick="copyCode(this)" data-code='${attr}'>复制</button>` +
                    `<button class="code-action" onclick="downloadXml(this)" data-code='${attr}'>下载 XML</button>` +
                    `<button class="code-action" onclick="validateXml(this)" data-code='${attr}'>校验 XSD</button>` +
                    (isSendable
                        ? `<button class="code-action send-tia" onclick="sendToTia(this)" data-code='${attr}'>发送至博途</button>`
                        : `<span class="code-action-hint">⚠️ ${detectedLangLabel} 块级 XML 暂不支持自动写入；请复制到博途编辑器粘贴</span>`);
            } else {
                // SCL / STL 纯源码走 Openness ExternalSources 通道，博途自己编译成块，
                // 因此同样可以一键写入（不需要模型去拼 token 级 XML）。
                // S7DCL(文本 LAD:RUNG/Contact)走在线引擎文档导入通道,同样可写入。
                // 三个前提缺一不可：语言匹配、块声明与 END 配对、围栏已正常闭合。
                const isSclOrStl = /^(scl|stl)$/i.test(lang);
                const isS7Dcl = /RUNG\s+wire#/i.test(rawCode);
                const isSourceKind = isSclOrStl || isS7Dcl;
                const src = isSourceKind ? classifySourcePayload(rawCode) : { ok: false, reason: 'not-source' };
                const looksLikeSource = src.ok && !fenceWasUnclosed && !isStreaming;
                actionBtns =
                    `<button class="code-action" onclick="copyCode(this)" data-code='${attr}'>复制</button>` +
                    (looksLikeSource
                        ? `<button class="code-action send-tia" onclick="sendToTia(this)" data-code='${attr}'>发送至博途</button>`
                        : !isSourceKind
                            ? ''
                            : src.reason === 'no-decl'
                                ? `<span class="code-action-hint">⚠️ 这是代码片段，缺少 FUNCTION_BLOCK / FUNCTION 块声明，无法写入博途；请让 AI 输出完整块结构</span>`
                                : src.reason === 'no-end'
                                    ? `<span class="code-action-hint">⚠️ 源码不完整（缺少配对的 END_FUNCTION_BLOCK 等结束标记），无法写入博途</span>`
                                    : `<span class="code-action-hint">⚠️ 源码尚未输出完成，完成后可写入博途</span>`);
            }
            return `<div class="code-block"><div class="code-header"><span>${langLabel}</span>${actionBtns}</div><pre><code>${cleanCode}</code></pre></div>`;
        });

        return formatted;
    },

    escapeAttr(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/'/g, '&#39;')
            .replace(/"/g, '&quot;');
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },
};

export {
    detectLanguageIntent,
    classifySourcePayload,
    identifyCodeType
};
