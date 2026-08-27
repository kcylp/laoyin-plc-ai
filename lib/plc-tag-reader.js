'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function errorText(error) {
    return error && error.message ? String(error.message) : String(error || '未知错误');
}

function withCause(message, cause) {
    return new Error(`${message}：${errorText(cause)}`, { cause });
}

function jsonPayload(result) {
    if (!result || typeof result !== 'object') return result;
    if (!Array.isArray(result.content)) return result;
    const text = result.content
        .filter(item => item && item.type === 'text')
        .map(item => String(item.text || ''))
        .join('\n');
    if (!text.trim()) throw new Error('MCP 响应没有文本内容');
    try {
        return JSON.parse(text);
    } catch (error) {
        throw withCause('MCP 响应不是有效 JSON', error);
    }
}

function parseTagTableNames(result) {
    const payload = jsonPayload(result);
    const items = Array.isArray(payload) ? payload : payload && (payload.items ?? payload.Items);
    if (!Array.isArray(items) || items.some(item => typeof item !== 'string')) {
        throw new Error('变量表列表响应格式无效：预期 ResponseStringList.items 字符串数组');
    }
    return items.map(item => item.trim()).filter(Boolean);
}

function decodeXml(value) {
    return String(value || '')
        .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&#([0-9]+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function elementText(xml, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(xml || '').match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
    if (!match) return '';
    return decodeXml(match[1].replace(/<[^>]+>/g, '')).trim();
}

function parseComment(attributeList) {
    const source = String(attributeList || '');
    const comment = source.match(/<Comment(?:\s[^>]*)?>([\s\S]*?)<\/Comment>/i)
        || source.match(/<MultilingualText\b(?=[^>]*\bCompositionName\s*=\s*["']Comment["'])[^>]*>([\s\S]*?)<\/MultilingualText>/i);
    if (!comment) return '';
    const texts = [...comment[1].matchAll(/<Text(?:\s[^>]*)?>([\s\S]*?)<\/Text>/gi)]
        .map(match => decodeXml(match[1].replace(/<[^>]+>/g, '')).trim())
        .filter(Boolean);
    return texts[0] || '';
}

function parsePlcTagTableXml(xml, expectedName = '') {
    const source = String(xml || '');
    const tableMatch = source.match(/<SW\.Tags\.PlcTagTable\b[^>]*>([\s\S]*?)<\/SW\.Tags\.PlcTagTable>/i);
    if (!tableMatch) throw new Error('缺少 SW.Tags.PlcTagTable 节点');
    const tableBody = tableMatch[1];
    const objectListAt = tableBody.search(/<ObjectList\b/i);
    const tableAttributes = objectListAt >= 0 ? tableBody.slice(0, objectListAt) : tableBody;
    const name = elementText(tableAttributes, 'Name') || String(expectedName || '').trim();
    if (!name) throw new Error('变量表缺少 Name');

    const tags = [];
    const tagPattern = /<SW\.Tags\.PlcTag\b[^>]*>([\s\S]*?)<\/SW\.Tags\.PlcTag>/gi;
    for (const match of tableBody.matchAll(tagPattern)) {
        const attributeMatch = match[1].match(/<AttributeList\b[^>]*>([\s\S]*?)<\/AttributeList>/i);
        if (!attributeMatch) throw new Error(`变量表 ${name} 中的标签缺少 AttributeList`);
        const attributes = attributeMatch[1];
        const tagName = elementText(attributes, 'Name');
        if (!tagName) throw new Error(`变量表 ${name} 中存在缺少 Name 的标签`);
        tags.push({
            name: tagName,
            dataType: elementText(attributes, 'DataTypeName'),
            logicalAddress: elementText(attributes, 'LogicalAddress'),
            comment: parseComment(match[1]),
        });
    }
    return { name, tags };
}

async function readAllPlcTags(client, options = {}) {
    const softwarePath = String(options.softwarePath || 'PLC_1').trim() || 'PLC_1';
    let names;
    try {
        names = parseTagTableNames(await client.callTool('GetPlcTagTables', { softwarePath }, 60000));
    } catch (error) {
        if (/变量表列表响应格式无效/.test(errorText(error))) throw error;
        throw withCause('读取变量表列表失败', error);
    }
    if (names.length === 0) return [];

    const exportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'laoyin-plc-tags-'));
    try {
        const tables = [];
        for (let index = 0; index < names.length; index += 1) {
            const tagTableName = names[index];
            const requestedPath = path.join(exportDir, `tag-table-${index + 1}.xml`);
            let exportResult;
            try {
                exportResult = await client.callTool('ExportPlcTagTable', {
                    softwarePath,
                    tagTableName,
                    exportPath: requestedPath,
                }, 60000);
            } catch (error) {
                throw withCause(`导出变量表 ${tagTableName} 失败`, error);
            }

            const payload = jsonPayload(exportResult);
            const reportedPath = payload && (payload.exportPath || payload.ExportPath);
            const xmlPath = String(reportedPath || requestedPath);
            const resolvedPath = path.resolve(xmlPath);
            const resolvedDir = path.resolve(exportDir) + path.sep;
            if (!resolvedPath.startsWith(resolvedDir)) {
                throw new Error(`导出变量表 ${tagTableName} 失败：返回路径不在临时目录内`);
            }

            let xml;
            try {
                xml = await fs.readFile(resolvedPath, 'utf8');
            } catch (error) {
                throw withCause(`读取变量表 ${tagTableName} 导出文件失败`, error);
            }
            try {
                tables.push(parsePlcTagTableXml(xml, tagTableName));
            } catch (error) {
                throw withCause(`解析变量表 ${tagTableName} 失败`, error);
            }
        }
        return tables;
    } finally {
        await fs.rm(exportDir, { recursive: true, force: true });
    }
}

module.exports = {
    parsePlcTagTableXml,
    parseTagTableNames,
    readAllPlcTags,
};
