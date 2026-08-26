const { TiaMcpClient, getSharedClient } = require('../tia-mcp-client');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_BLOCKS = 30;
const DEFAULT_MAX_RELEVANT_VARIABLES = 30;
const DEFAULT_MAX_EXPLICIT_VARIABLES = 200;
const DEFAULT_MAX_PROMPT_CHARS = 9000;

function collapse(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function pickString(source, keys) {
    if (!source || typeof source !== 'object') return '';
    for (const key of keys) {
        const value = source[key];
        if (value !== undefined && value !== null && String(value).trim()) return collapse(value);
    }
    return '';
}

function arrayOf(value) {
    return Array.isArray(value) ? value : [];
}

function unique(items) {
    return [...new Set(items.filter(Boolean))];
}

function normalizeBlocks(blocks) {
    return arrayOf(blocks).map(block => ({
        name: pickString(block, ['name', 'Name', 'blockName', 'BlockName']),
        type: pickString(block, ['type', 'Type', 'blockType', 'BlockType']),
        lang: pickString(block, ['lang', 'Lang', 'language', 'Language']),
        path: pickString(block, ['path', 'Path', 'blockPath', 'BlockPath'])
    })).filter(block => block.name);
}

function rawTagTables(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    return arrayOf(payload.Items)
        .concat(arrayOf(payload.items))
        .concat(arrayOf(payload.Tables))
        .concat(arrayOf(payload.tables))
        .concat(arrayOf(payload.TagTables))
        .concat(arrayOf(payload.tagTables));
}

function rawVariables(table) {
    if (!table || typeof table !== 'object') return [];
    return arrayOf(table.variables)
        .concat(arrayOf(table.Variables))
        .concat(arrayOf(table.tags))
        .concat(arrayOf(table.Tags))
        .concat(arrayOf(table.items))
        .concat(arrayOf(table.Items))
        .concat(arrayOf(table.rows))
        .concat(arrayOf(table.Rows));
}

function normalizeTagTables(payload) {
    return rawTagTables(payload).map((table, index) => {
        const name = pickString(table, ['name', 'Name', 'tableName', 'TableName']) || `变量表${index + 1}`;
        const variables = rawVariables(table).map(variable => ({
            table: name,
            name: pickString(variable, ['name', 'Name', 'tagName', 'TagName', 'symbol', 'Symbol']),
            address: pickString(variable, ['address', 'Address', 'logicalAddress', 'LogicalAddress', 'addr', 'Addr']),
            dataType: pickString(variable, ['dataType', 'DataType', 'datatype', 'Datatype', 'type', 'Type']),
            comment: pickString(variable, ['comment', 'Comment', 'commentZhCn', 'CommentZhCn', 'description', 'Description'])
        })).filter(variable => variable.name || variable.address || variable.comment);
        return { name, variables };
    }).filter(table => table.name || table.variables.length);
}

function countVariables(tagTables) {
    return normalizeTagTables(tagTables).reduce((sum, table) => sum + table.variables.length, 0);
}

function normalizeTechnologyObjects(raw) {
    return arrayOf(raw && (raw.technologyObjects || raw.TechnologyObjects)).map(item => ({
        name: pickString(item, ['name', 'Name']),
        type: pickString(item, ['type', 'Type']),
        db: pickString(item, ['db', 'DB', 'dataBlock', 'DataBlock'])
    })).filter(item => item.name);
}

function extractPlcFromTree(tree) {
    const line = String(tree || '').split(/\r?\n/).find(row => /CPU|S7-12|S7-15/i.test(row)) || '';
    const article = (line.match(/6ES7[\w\s.-]+/i) || [''])[0].trim();
    const firmware = (line.match(/\bV\d+(?:\.\d+){0,2}\b/i) || [''])[0].trim();
    const model = collapse(line.replace(/[│├└─\[\]]/g, ' ')).replace(article, '').replace(firmware, '').trim();
    return { name: '', model, articleNumber: article, firmware };
}

function normalizeContext(raw) {
    const context = raw && typeof raw === 'object' ? raw : {};
    const tagTables = normalizeTagTables(context.tagTables || context.tables || context.Tags || context.rawTagTables || []);
    const treePlc = extractPlcFromTree(context.tree || '');
    const plc = {
        name: pickString(context.plc, ['name', 'Name']) || treePlc.name,
        model: pickString(context.plc, ['model', 'Model', 'type', 'Type']) || treePlc.model,
        articleNumber: pickString(context.plc, ['articleNumber', 'ArticleNumber', 'orderNumber', 'OrderNumber', 'mlfb', 'MLFB']) || treePlc.articleNumber,
        firmware: pickString(context.plc, ['firmware', 'Firmware', 'firmwareVersion', 'FirmwareVersion']) || treePlc.firmware
    };
    return {
        connected: context.connected !== false,
        note: pickString(context, ['note', 'message', 'error']),
        project: pickString(context, ['project', 'projectName', 'ProjectName']),
        portalVersion: pickString(context, ['portalVersion', 'tiaVersion', 'engineeringVersion']) || (context.tiaMajorVersion ? `V${context.tiaMajorVersion}` : ''),
        plc,
        blocks: normalizeBlocks(context.blocks),
        tagTables,
        technologyObjects: normalizeTechnologyObjects(context),
        warnings: arrayOf(context.warnings)
    };
}

function summarizeProjectContext(raw, options = {}) {
    const context = normalizeContext(raw);
    const maxBlocks = options.maxBlocks || DEFAULT_MAX_BLOCKS;
    const blockCount = context.blocks.length;
    const tableCount = context.tagTables.length;
    const variableCount = countVariables(context.tagTables);

    if (!context.connected) {
        const note = context.note || '博途里没有已打开的项目';
        const text = `【当前博途工程】未连接博途（${note}）\n未连接博途，以下地址为示例；生成内容需要按实际工程变量表调整。`;
        return { text, connected: false, project: '', blockCount: 0, tableCount: 0, variableCount: 0, charCount: text.length };
    }

    const plcParts = [];
    if (context.plc.model) plcParts.push(context.plc.model);
    if (context.plc.articleNumber) plcParts.push(`订货号 ${context.plc.articleNumber}`);
    if (context.plc.firmware) plcParts.push(`固件 ${context.plc.firmware}`);

    const projectLine = [
        context.project || '未知工程',
        context.portalVersion ? `博途 ${context.portalVersion}` : '博途版本未知',
        ...plcParts
    ].join(' | ');
    const blockItems = context.blocks.slice(0, maxBlocks).map(block => {
        const suffix = [block.type, block.lang].filter(Boolean).join(',');
        return suffix ? `${block.name}[${suffix}]` : block.name;
    });
    const blockTail = blockCount > maxBlocks ? ` ...另 ${blockCount - maxBlocks} 个` : '';
    const techObjects = context.technologyObjects.map(item => {
        const suffix = [item.type, item.db].filter(Boolean).join(', ');
        return suffix ? `${item.name}[${suffix}]` : item.name;
    });

    const lines = [
        `【当前博途工程】${projectLine}`,
        `【已有程序块】${blockItems.join(' ')}${blockTail}`,
        `【变量表】共 ${tableCount} 张、${variableCount} 个变量（详见需要时展开）`
    ];
    if (techObjects.length) lines.push(`【工艺对象】${techObjects.join(' ')}`);
    if (context.warnings.length) lines.push(`【上下文提示】${context.warnings.join('；')}`);
    const text = lines.join('\n');
    return { text, connected: true, project: context.project, blockCount, tableCount, variableCount, charCount: text.length };
}

function messageKeywords(message) {
    const text = collapse(message).toLowerCase();
    const words = text.split(/[^a-z0-9_%\.\u4e00-\u9fff]+/i).filter(word => word.length >= 2);
    const cjkSegments = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
    const grams = [];
    for (const segment of cjkSegments) {
        for (let size = 2; size <= 4; size += 1) {
            for (let i = 0; i <= segment.length - size; i += 1) grams.push(segment.slice(i, i + size));
        }
    }
    const domainWords = ['启动', '停止', '急停', '电机', '运行', '复位', '报警', '故障', '分度', '转盘', '按钮', '使能', '原点', '速度', '位置', '限位', '安全'];
    return unique(words.concat(grams).concat(domainWords.filter(word => text.includes(word))));
}

function variableHaystack(variable) {
    return [variable.name, variable.address, variable.dataType, variable.comment].map(item => collapse(item).toLowerCase()).join(' ');
}

function formatVariable(variable) {
    const address = variable.address ? ` (${variable.address})` : '';
    const dataType = variable.dataType ? ` : ${variable.dataType}` : '';
    const comment = variable.comment ? ` - ${variable.comment}` : '';
    return `${variable.name}${address}${dataType}${comment}`;
}

function matchRelevantContext(raw, message = '', options = {}) {
    const context = normalizeContext(raw);
    const maxVariables = options.maxVariables || DEFAULT_MAX_RELEVANT_VARIABLES;
    const keywords = messageKeywords(message);
    const variables = [];
    let totalMatches = 0;

    if (context.connected && keywords.length) {
        for (const table of context.tagTables) {
            for (const variable of table.variables) {
                const haystack = variableHaystack(variable);
                const matched = keywords.some(keyword => haystack.includes(keyword));
                if (!matched) continue;
                totalMatches += 1;
                if (variables.length < maxVariables) variables.push({ ...variable, table: table.name });
            }
        }
    }

    const lines = variables.map(variable => `  ${formatVariable(variable)}`);
    const truncated = totalMatches > variables.length;
    const text = lines.length
        ? `【相关变量】（根据本轮问题自动筛选，${variables.length}${truncated ? `/${totalMatches}` : ''} 条）\n${lines.join('\n')}`
        : '';
    return { text, variables, truncated, totalMatches, charCount: text.length };
}

function explicitProjectContext(raw, options = {}) {
    if (!options.includeAllVariables) {
        return { text: '', variables: [], truncated: false, totalVariables: 0, charCount: 0 };
    }

    const context = normalizeContext(raw);
    if (!context.connected) {
        return { text: '', variables: [], truncated: false, totalVariables: 0, charCount: 0 };
    }

    const maxVariables = options.maxExplicitVariables || DEFAULT_MAX_EXPLICIT_VARIABLES;
    const variables = [];
    let totalVariables = 0;
    for (const table of context.tagTables) {
        for (const variable of table.variables) {
            totalVariables += 1;
            if (variables.length < maxVariables) variables.push({ ...variable, table: table.name });
        }
    }

    const truncated = totalVariables > variables.length;
    const lines = variables.map(variable => `  [${variable.table}] ${formatVariable(variable)}`);
    const text = lines.length
        ? `【完整变量表】（用户显式要求注入，${variables.length}${truncated ? `/${totalVariables}` : ''} 条）\n${lines.join('\n')}`
        : '';
    return { text, variables, truncated, totalVariables, charCount: text.length };
}

function buildProjectContextPrompt(raw, options = {}) {
    const summary = summarizeProjectContext(raw, options);
    const relevant = matchRelevantContext(raw, options.message || '', options);
    const explicit = explicitProjectContext(raw, options);
    const parts = [summary.text];
    if (relevant.text) parts.push(relevant.text);
    if (explicit.text) parts.push(explicit.text);

    let text = parts.join('\n');
    const maxPromptChars = options.maxPromptChars || DEFAULT_MAX_PROMPT_CHARS;
    let truncated = false;
    if (text.length > maxPromptChars) {
        text = text.slice(0, maxPromptChars) + '\n【上下文提示】本轮上下文超过上限，已截断。';
        truncated = true;
    }

    const status = {
        connected: summary.connected,
        project: summary.project || '',
        blockCount: summary.blockCount,
        tableCount: summary.tableCount,
        variableCount: summary.variableCount,
        totalVars: summary.variableCount,
        relevantVariableCount: relevant.variables.length,
        relevantTotalMatches: relevant.totalMatches,
        relevantTruncated: relevant.truncated,
        explicitVariableCount: explicit.variables.length,
        explicitTotalVariables: explicit.totalVariables,
        explicitTruncated: explicit.truncated,
        promptTruncated: truncated,
        charCount: text.length,
        tokenEstimate: Math.ceil(text.length / 3),
    };
    return { text, status, relevant, explicit, summary };
}

function createTiaContextLoader(options = {}) {
    const enqueueTiaOp = options.enqueueTiaOp;
    const mcpEnsureAttached = options.mcpEnsureAttached;
    const parseBlocksFromTree = options.parseBlocksFromTree || (() => []);
    const getMcpClient = options.getMcpClient || getSharedClient;

    return async function loadTiaContext() {
        if (typeof enqueueTiaOp !== 'function' || typeof mcpEnsureAttached !== 'function') {
            return { connected: false, note: '项目上下文服务未配置 TIA 队列' };
        }

        return enqueueTiaOp(async () => {
            const client = getMcpClient();
            const attached = await mcpEnsureAttached(client);
            if (!attached || !attached.ok) {
                return { connected: false, note: (attached && attached.note) || '博途里没有已打开的项目' };
            }

            const treeResult = await client.callTool('GetSoftwareTree', { softwarePath: 'PLC_1' }, 60000);
            const treeJson = TiaMcpClient.jsonOf(treeResult) || {};
            const tree = treeJson.tree || treeJson.text || TiaMcpClient.textOf(treeResult) || '';
            const blocks = parseBlocksFromTree(tree);
            const warnings = [];
            let tagTables = [];
            try {
                const tagResult = await client.callTool('GetPlcTagTables', { softwarePath: 'PLC_1' }, 60000);
                tagTables = normalizeTagTables(TiaMcpClient.jsonOf(tagResult) || {});
            } catch (error) {
                warnings.push(`变量表读取失败：${error.message}`);
            }

            const status = typeof client.status === 'function' ? client.status() : {};
            return {
                connected: true,
                project: attached.project || '',
                portalVersion: status.tiaMajorVersion ? `V${status.tiaMajorVersion}` : '',
                tiaMajorVersion: status.tiaMajorVersion,
                plc: extractPlcFromTree(tree),
                tree,
                blocks,
                tagTables,
                warnings
            };
        });
    };
}

function createProjectContextService(options = {}) {
    const ttlMs = options.ttlMs == null ? DEFAULT_TTL_MS : Number(options.ttlMs);
    const cache = new Map();
    const loadContext = options.loadContext || createTiaContextLoader(options);
    const getWriteRevision = options.getWriteRevision || (() => 0);
    const now = options.now || (() => Date.now());

    async function revisionFor(userId) {
        try {
            return String(await getWriteRevision(userId));
        } catch {
            return '0';
        }
    }

    async function readRawContext(userId, forceRefresh) {
        const revision = await revisionFor(userId);
        const cached = cache.get(userId);
        const age = cached ? now() - cached.updatedAt : Infinity;
        const valid = cached && !forceRefresh && cached.revision === revision && age < ttlMs;
        if (valid) return { raw: cached.raw, revision, cacheHit: true, updatedAt: cached.updatedAt };

        let raw;
        try {
            raw = await loadContext({ userId });
        } catch (error) {
            raw = { connected: false, note: `项目上下文获取失败：${error.message}` };
        }
        const updatedAt = now();
        cache.set(userId, { raw, revision, updatedAt });
        return { raw, revision, cacheHit: false, updatedAt };
    }

    async function getPromptContext({ userId, message = '', forceRefresh = false, includeAllVariables = false } = {}) {
        const { raw, revision, cacheHit, updatedAt } = await readRawContext(userId, forceRefresh);
        const built = buildProjectContextPrompt(raw, { ...options, message, includeAllVariables });
        const status = { ...built.status, revision, cacheHit, lastUpdated: updatedAt, enabled: true };
        return { prompt: built.text, status, details: { prompt: built.text, relevant: built.relevant, explicit: built.explicit, summary: built.summary } };
    }

    function getStatus(userId) {
        const cached = cache.get(userId);
        if (!cached) {
            return { connected: false, enabled: true, project: '', blockCount: 0, tableCount: 0, variableCount: 0, totalVars: 0, lastUpdated: 0, summary: '尚未采集项目上下文' };
        }
        const built = buildProjectContextPrompt(cached.raw, options);
        return { ...built.status, revision: cached.revision, cacheHit: true, lastUpdated: cached.updatedAt, enabled: true, summary: built.text };
    }

    function invalidate(userId) {
        if (userId) cache.delete(userId);
        else cache.clear();
    }

    async function refresh({ userId, message = '', includeAllVariables = false } = {}) {
        return getPromptContext({ userId, message, forceRefresh: true, includeAllVariables });
    }

    return { getPromptContext, getStatus, invalidate, refresh, _cache: cache };
}

module.exports = {
    buildProjectContextPrompt,
    createProjectContextService,
    createTiaContextLoader,
    matchRelevantContext,
    normalizeTagTables,
    summarizeProjectContext,
};
