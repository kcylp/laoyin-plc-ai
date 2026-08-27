const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const DEFAULT_LIMIT = 3;
const DEFAULT_MAX_PROMPT_CHARS = 9000;
const WORKFLOWS = {
    A: { id: 'A', title: '新建工程', file: 'workflows/A-新建工程.md' },
    B: { id: 'B', title: '存量工程改造', file: 'workflows/B-存量工程改造.md' },
    C: { id: 'C', title: '读懂现有程序', file: 'workflows/C-读懂现有程序.md' },
    D: { id: 'D', title: '排查编译错误', file: 'workflows/D-排查编译错误.md' },
};

function collapse(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function unique(items) {
    return [...new Set(items.filter(Boolean))];
}

function toArray(value) {
    return Array.isArray(value) ? value : [];
}

function parseScalar(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (text.startsWith('[') && text.endsWith(']')) {
        try {
            return JSON.parse(text);
        } catch {
            return text.slice(1, -1).split(',').map(item => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        }
    }
    try {
        return JSON.parse(text);
    } catch {
        return text.replace(/^["']|["']$/g, '');
    }
}

function parseFrontmatter(content) {
    const text = String(content || '').replace(/\r\n/g, '\n');
    const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!match) return { meta: {}, body: text };
    const meta = {};
    for (const line of match[1].split(/\n/)) {
        const separator = line.indexOf(':');
        if (separator <= 0) continue;
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        meta[key] = parseScalar(value);
    }
    return { meta, body: text.slice(match[0].length) };
}

function readUtf8(file) {
    return fs.readFileSync(file, 'utf8');
}

function fileExists(file) {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

function textTerms(text) {
    const normalized = collapse(text).toLowerCase();
    const words = normalized.split(/[^a-z0-9_%#\.\u4e00-\u9fff]+/i).filter(word => word.length >= 2);
    const cjk = normalized.match(/[\u4e00-\u9fff]{2,}/g) || [];
    const grams = [];
    for (const segment of cjk) {
        for (let size = 2; size <= 4; size += 1) {
            for (let i = 0; i <= segment.length - size; i += 1) grams.push(segment.slice(i, i + size));
        }
    }
    return unique(words.concat(grams));
}

function scoreEntry(entry, message) {
    const terms = textTerms(message);
    const title = collapse(entry.title || entry['标题']).toLowerCase();
    const category = collapse(entry.category || entry['分类']).toLowerCase();
    const keywords = toArray(entry.keywords || entry['关键词']).map(item => collapse(item).toLowerCase());
    const examples = toArray(entry.exampleRequests || entry['示例需求']).map(item => collapse(item).toLowerCase());
    const haystack = [title, category, keywords.join(' '), examples.join(' ')].join(' ');
    let score = 0;
    const matchedTerms = [];

    for (const term of terms) {
        if (!term) continue;
        if (title.includes(term)) {
            score += 12;
            matchedTerms.push(term);
        } else if (keywords.some(keyword => keyword.includes(term) || term.includes(keyword))) {
            score += 8;
            matchedTerms.push(term);
        } else if (haystack.includes(term)) {
            score += term.length >= 3 ? 4 : 2;
            matchedTerms.push(term);
        }
    }

    for (const keyword of keywords) {
        if (keyword && collapse(message).toLowerCase().includes(keyword)) {
            score += 10;
            matchedTerms.push(keyword);
        }
    }
    return { score, matchedTerms: unique(matchedTerms) };
}

function selectWorkflow(projectContextStatus = {}, message = '') {
    const text = collapse(message).toLowerCase();
    if (/报错|错误|编译|导入|error|exception|missing|invalid|uid|line number|line\s+\d+/i.test(text)) return WORKFLOWS.D;
    if (/读懂|解释|分析|这段程序|反推|看懂|review/i.test(text)) return WORKFLOWS.C;
    const connected = projectContextStatus.connected === true;
    const blockCount = Number(projectContextStatus.blockCount || 0);
    if (!connected || blockCount <= 0) return WORKFLOWS.A;
    return WORKFLOWS.B;
}

function filterPendingSections(markdown) {
    const lines = String(markdown || '').split(/\r?\n/).map(line => line.replace(/\r$/, ''));
    const kept = [];
    let skipping = false;
    let skipLevel = 0;
    let pendingSectionsFiltered = 0;

    for (const line of lines) {
        const heading = line.match(/^(#{1,6})\s+/);
        if (heading) {
            const level = heading[1].length;
            if (skipping && level <= skipLevel) {
                skipping = false;
                skipLevel = 0;
            }
            const isPendingSafety = /⚠️【待老殷审】/.test(line)
                && (/常见坑|上机前必须确认/.test(line) || level >= 3);
            if (isPendingSafety) {
                skipping = true;
                skipLevel = level;
                pendingSectionsFiltered += 1;
                continue;
            }
        }
        if (!skipping) kept.push(line);
    }
    return { text: kept.join('\n').trim(), pendingSectionsFiltered };
}

function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 2.2);
}

function summarizeDocForPrompt(doc, maxChars) {
    const filtered = filterPendingSections(doc.body);
    let text = filtered.text;
    let truncated = false;
    if (text.length > maxChars) {
        text = text.slice(0, maxChars).replace(/\s+\S*$/, '').trim() + '\n（本条知识超过本轮上限，已截断）';
        truncated = true;
    }
    return { text, truncated, pendingSectionsFiltered: filtered.pendingSectionsFiltered };
}

function normalizeIndexEntry(entry) {
    return {
        id: entry.id,
        title: entry.title || entry['标题'] || '',
        category: entry.category || entry['分类'] || '',
        keywords: toArray(entry.keywords || entry['关键词']),
        appliesTo: toArray(entry.appliesTo || entry['适用']),
        difficulty: entry.difficulty || entry['难度'] || '',
        generationStatus: entry.generationStatus || entry['可生成性'] || '',
        generationMark: entry.generationMark || '',
        exampleRequests: toArray(entry.exampleRequests || entry['示例需求']),
        file: entry.file || entry['文件'] || '',
        review_status: entry.review_status || 'pending',
        source: entry.source || 'knowledge/index.json',
        raw: entry
    };
}

function createKnowledgeService(options = {}) {
    const rootDir = options.rootDir || DEFAULT_ROOT;
    const knowledgeDir = options.knowledgeDir || path.join(rootDir, 'knowledge');
    const indexPath = path.join(knowledgeDir, 'index.json');
    let indexCache = null;
    const docCache = new Map();

    function loadIndex() {
        if (indexCache) return indexCache;
        if (!fileExists(indexPath)) {
            indexCache = [];
            return indexCache;
        }
        indexCache = JSON.parse(readUtf8(indexPath)).map(normalizeIndexEntry);
        return indexCache;
    }

    function readDocByEntry(entry) {
        const file = path.join(knowledgeDir, entry.file);
        if (docCache.has(file)) return docCache.get(file);
        const raw = readUtf8(file);
        const parsed = parseFrontmatter(raw);
        const doc = {
            id: parsed.meta.id || entry.id,
            title: parsed.meta.title || parsed.meta['标题'] || entry.title,
            meta: parsed.meta,
            body: parsed.body,
            content: raw,
            file: entry.file,
            review: {
                status: parsed.meta.review_status || entry.review_status || 'pending',
                pendingSections: (raw.match(/⚠️【待老殷审】/g) || []).length
            },
            warning: /⚠️【待老殷审】/.test(raw) || parsed.meta.review_status === 'pending'
                ? '含未经领域专家审定的安全节：仅供浏览，AI prompt 已自动隔离。'
                : ''
        };
        docCache.set(file, doc);
        return doc;
    }

    function readWorkflow(workflow) {
        const file = path.join(knowledgeDir, workflow.file);
        if (!fileExists(file)) return '';
        const parsed = parseFrontmatter(readUtf8(file));
        const lines = parsed.body.split(/\r?\n/).map(line => line.replace(/\r$/, '')).slice(0, 80);
        return lines.join('\n').trim();
    }

    function searchKnowledge(message, searchOptions = {}) {
        const limit = searchOptions.limit || DEFAULT_LIMIT;
        return loadIndex()
            .map(entry => ({ entry, ...scoreEntry(entry, message) }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title, 'zh-Hans-CN'))
            .slice(0, limit)
            .map(item => ({
                id: item.entry.id,
                title: item.entry.title,
                category: item.entry.category,
                score: item.score,
                matchedTerms: item.matchedTerms,
                file: item.entry.file,
                review_status: item.entry.review_status
            }));
    }

    function buildKnowledgePrompt(promptOptions = {}) {
        const message = promptOptions.message || '';
        const limit = promptOptions.limit || DEFAULT_LIMIT;
        const maxPromptChars = promptOptions.maxPromptChars || DEFAULT_MAX_PROMPT_CHARS;
        const hits = searchKnowledge(message, { limit });
        const workflow = selectWorkflow(promptOptions.projectContextStatus || {}, message);
        const status = {
            enabled: true,
            workflow,
            matches: hits,
            charCount: 0,
            tokenEstimate: 0,
            truncated: false,
            pendingSectionsFiltered: 0
        };
        if (!hits.length) return { prompt: '', status, docs: [] };

        const perDocMax = Math.max(1200, Math.floor((maxPromptChars - 1200) / Math.max(hits.length, 1)));
        const docs = hits.map(hit => readDocByEntry(loadIndex().find(entry => entry.id === hit.id)));
        const docParts = [];
        let pendingSectionsFiltered = 0;
        let truncated = false;
        for (const doc of docs) {
            const summary = summarizeDocForPrompt(doc, perDocMax);
            pendingSectionsFiltered += summary.pendingSectionsFiltered;
            truncated = truncated || summary.truncated;
            docParts.push(`### 《${doc.title}》\n${summary.text}`);
        }

        const workflowText = readWorkflow(workflow);
        const workflowPart = workflowText
            ? `\n\n【工作流摘要：${workflow.title}】\n${workflowText.slice(0, 1800)}`
            : '';
        let prompt = [
            `【知识库】参考：${hits.map(hit => `《${hit.title}》`).join('、')} · 工作流：${workflow.title}`,
            '请优先按这些通用模式、命名/注释口径和当前工程上下文回答；未经审定的安全节已从本段中剔除，不能把剔除内容当成依据。',
            ...docParts,
            workflowPart
        ].filter(Boolean).join('\n\n');

        if (prompt.length > maxPromptChars) {
            prompt = prompt.slice(0, maxPromptChars).replace(/\s+\S*$/, '').trim() + '\n【知识库提示】本轮知识库上下文超过上限，已截断。';
            truncated = true;
        }
        status.charCount = prompt.length;
        status.tokenEstimate = estimateTokens(prompt);
        status.truncated = truncated;
        status.pendingSectionsFiltered = pendingSectionsFiltered;
        return { prompt, status, docs };
    }

    function getScenarioCards(limit = 12) {
        const entries = loadIndex().filter(entry => entry.exampleRequests.length);
        const primary = entries.filter(entry =>
            entry.difficulty === '入门' && ['基础逻辑', '常用设备'].includes(entry.category)
        );
        const selected = primary.concat(entries.filter(entry => !primary.some(item => item.id === entry.id)));
        return selected
            .slice(0, limit)
            .map(entry => ({
                id: entry.id,
                title: entry.title,
                category: entry.category,
                difficulty: entry.difficulty,
                prompt: entry.exampleRequests[0],
                source: 'knowledge/index.json'
            }));
    }

    function readKnowledgeDoc(id) {
        const entry = loadIndex().find(item => item.id === id || item.title === id);
        if (!entry) {
            const error = new Error('知识库条目不存在');
            error.code = 'NOT_FOUND';
            throw error;
        }
        return readDocByEntry(entry);
    }

    function listKnowledgeDocs() {
        return loadIndex().map(entry => ({
            id: entry.id,
            title: entry.title,
            category: entry.category,
            difficulty: entry.difficulty,
            file: entry.file,
            review_status: entry.review_status
        }));
    }

    return {
        buildKnowledgePrompt,
        getScenarioCards,
        listKnowledgeDocs,
        readKnowledgeDoc,
        searchKnowledge,
        selectWorkflow,
        _loadIndex: loadIndex
    };
}

const defaultService = createKnowledgeService();

module.exports = {
    createKnowledgeService,
    defaultService,
    filterPendingSections,
    parseFrontmatter,
    scoreEntry,
    searchKnowledge: (...args) => defaultService.searchKnowledge(...args),
    selectWorkflow,
};
