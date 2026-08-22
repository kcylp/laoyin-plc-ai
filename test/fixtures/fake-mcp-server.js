// 单测用的假 MCP stdio 服务器:收到 initialize 回 serverInfo,tools/list 回两个
// 假工具,tools/call 回显参数;其余回 method not found。
let buffer = '';
process.stdin.on('data', (chunk) => {
    buffer += String(chunk);
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === undefined || msg.id === null) continue; // 通知不回
        let result;
        if (msg.method === 'initialize') {
            result = { protocolVersion: msg.params.protocolVersion, serverInfo: { name: 'fake-tia', version: '0.0.1' }, capabilities: {} };
        } else if (msg.method === 'tools/list') {
            result = { tools: [{ name: 'FakeTool' }, { name: 'FailTool' }, { name: 'HangTool' }] };
        } else if (msg.method === 'tools/call') {
            if (msg.params.name === 'FailTool') {
                result = { content: [{ type: 'text', text: 'boom' }], isError: true };
            } else if (msg.params.name === 'HangTool') {
                continue;
            } else {
                result = { content: [{ type: 'text', text: JSON.stringify({ echo: msg.params.arguments }) }] };
            }
        } else {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }) + '\n');
            continue;
        }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    }
});
