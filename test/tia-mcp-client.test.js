const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { TiaMcpClient } = require('../tia-mcp-client');

const FAKE_SERVER = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');

function fakeClient() {
    return new TiaMcpClient({ exePath: process.execPath, args: [FAKE_SERVER], requestTimeoutMs: 5000 });
}

test('MCP client initializes, lists tools, and calls a tool (fake stdio server)', async () => {
    const client = fakeClient();
    try {
        const tools = await client.listTools();
        assert.deepEqual(tools.map(t => t.name), ['FakeTool', 'FailTool', 'HangTool']);

        const result = await client.callTool('FakeTool', { a: 1 });
        assert.deepEqual(TiaMcpClient.jsonOf(result), { echo: { a: 1 } });

        await assert.rejects(() => client.callTool('FailTool'), /boom/);

        const status = client.status();
        assert.equal(status.running, true);
        assert.equal(status.initialized, true);
        assert.equal(status.serverInfo.name, 'fake-tia');
    } finally {
        client.stop();
    }
    assert.equal(client.isRunning(), false);
});

test('MCP client reports unavailable when exe is missing', () => {
    const client = new TiaMcpClient({ exePath: 'Z:/no/such/exe.exe' });
    assert.equal(client.available(), false);
    assert.throws(() => client.start(), /不存在/);
});

test('MCP client rejects pending calls when the server process dies', async () => {
    const client = fakeClient();
    await client.ensureReady();
    const hang = client.callTool('FakeTool', {}); // 先杀掉再观察拒绝
    client.proc.kill();
    await assert.rejects(hang, /退出|停止/);
});

test('MCP timeout terminates the old process before a later call restarts safely', async () => {
    const client = fakeClient();
    try {
        await client.ensureReady();
        const oldProc = client.proc;
        await assert.rejects(() => client.callTool('HangTool', {}, 30), /超时/);
        await new Promise(resolve => oldProc.once('exit', resolve));
        assert.equal(client.isRunning(), false);
        const result = await client.callTool('FakeTool', { recovered: true });
        assert.deepEqual(TiaMcpClient.jsonOf(result), { echo: { recovered: true } });
        assert.notEqual(client.proc, oldProc);
    } finally {
        client.stop();
    }
});
