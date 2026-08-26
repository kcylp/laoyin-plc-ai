// AI 端到端实网验证(记忆 priority #1 首次闭环):
// 真实模型按 s1200_lad 提示词(已含 S7DCL 首选段)生成 → 引擎识别 → S7DCL 导入 → 编译。
// 全程走生产链路:llm 模块(数据库供应商) + engineer-yin-bridge(importToTia)。
require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const { init: initLlm, listUserModels, streamChat } = require('./llm');
const SYSTEM_PROMPTS = require('./prompts');
const { resolvePromptContent } = require('./prompt-router');
const { detectPayloadKind, preflightImport, importToTia, stopSharedEngineClients } = require('./engineer-yin-bridge');

const JWT_SECRET = process.env.JWT_SECRET;
const USER_ID = Number(process.env.E2E_USER_ID || 1);

if (!JWT_SECRET) {
    console.error('FAIL: JWT_SECRET environment variable is required for real AI E2E verification.');
    process.exit(1);
}
if (!Number.isInteger(USER_ID) || USER_ID <= 0) {
    console.error('FAIL: E2E_USER_ID must be a positive integer when provided.');
    process.exit(1);
}

async function aiChat(modelId, systemPrompt, userReq) {
    let text = '';
    await streamChat({ modelId, userId: USER_ID, messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userReq },
    ], onDelta: d => { text += d; } });
    return text;
}

function extractCode(text) {
    // 取第一个围栏内的代码(S7DCL/SCL/XML 均可)
    const m = /```[a-zA-Z]*\n?([\s\S]*?)```/.exec(text);
    return m ? m[1].trim() : text.trim();
}

(async () => {
    const db = new DatabaseSync('plc_assistant.db');
    initLlm(db, JWT_SECRET);

    const models = listUserModels(USER_ID);
    console.log('可用模型:', models.map(m => m.label || m.id).join(', '));
    if (!models.length) { console.log('无可用模型,终止'); db.close(); process.exitCode = 1; return; }
    const modelId = models[0].id;

    const lang = process.argv[2] || 'scl';
    const systemPrompt = resolvePromptContent(SYSTEM_PROMPTS, 's1200', lang);
    console.log('提示词语言:', lang, '含 S7DCL 首选段:', systemPrompt.includes('首选输出格式：S7DCL'));

    const requirement = lang === 'scl'
        ? '写一个电机启保停程序:启动按钮起保停自锁,带急停,运行 5 秒后自动停止,加一个批次计数器每启动一次加1,到达10次报警输出。用SCL。'
        : '写一个电机启保停程序:启动按钮起保停自锁,带急停,运行 5 秒后自动停止,加一个批次计数器每启动一次加1,到达10次报警输出。用梯形图。';
    console.log('\n需求:', requirement);

    console.log('\n-- AI 生成中...');
    const raw = await aiChat(modelId, systemPrompt, requirement);
    console.log('AI 输出长度:', raw.length);

    const code = extractCode(raw);
    const kind = detectPayloadKind(code);
    require('fs').writeFileSync(`work/e2e-ai-${lang}.txt`, code, 'utf8');
    console.log('\n生成代码片段(前 400 字):\n' + code.slice(0, 400));
    console.log('\n识别通道:', kind, kind === 's7dcl' ? '(S7DCL 文本 LAD)' : kind === 'xml' ? '(块级 XML)' : '(源码)');
    if (kind === 'scl') {
        console.log('\n计数器规则遵守检查:');
        console.log('  用 CTU_INT(禁 IEC_COUNTER):', /CTU_INT/.test(code));
        console.log('  禁泛型 IEC_COUNTER:', !/IEC_COUNTER/.test(code));
        console.log('  Q 用 => 绑定:', /Q\s*=>/.test(code));
    }

    if (!code || code.length < 50) { console.log('AI 输出异常,终止'); db.close(); process.exitCode = 1; return; }

    console.log('\n-- 预检(只读) --');
    const pre = await preflightImport(code, 'lad');
    console.log(`  ok=${pre.ok} block=${pre.blockName} type=${pre.blockType} kind=${pre.kind}`);
    if (pre.autoFixes) console.log('  autoFixes=', JSON.stringify(pre.autoFixes));
    if (!pre.ok) { console.log('  预检失败:', pre.message); db.close(); process.exitCode = 1; return; }

    console.log('\n-- 写入博途(真实导入) --');
    const r = await importToTia(code, true);
    console.log(`  ok=${r.ok} imported=${JSON.stringify(r.imported)}`);
    console.log(`  本块 errors=${r.errorCount} warnings=${r.warningCount} | 其他块 errors=${r.otherBlockErrors}`);
    if (r.autoFixes) console.log('  autoFixes=', JSON.stringify(r.autoFixes));
    if (!r.ok) {
        (r.messages || []).slice(0, 8).forEach(m => console.log('   ' + String(m).slice(0, 200)));
        if (r.message) console.log('   message: ' + String(r.message).slice(0, 300));
    }

    db.close();
})()
    .catch(e => { console.error('FAIL:', e.message); process.exitCode = 1; })
    .finally(() => {
        stopSharedEngineClients();
    });
