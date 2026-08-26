const test = require('node:test');
const assert = require('node:assert/strict');

const queue = require('../lib/tia-queue');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('TIA queue serializes five concurrent operations without overlap', async () => {
    queue._resetForTests();
    let active = 0;
    let maxActive = 0;
    const order = [];

    const jobs = Array.from({ length: 5 }, (_, i) => queue.enqueueTiaOp(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push('start-' + i);
        await delay(8);
        order.push('end-' + i);
        active -= 1;
        return i;
    }, { label: '并发测试 ' + i, timeoutMs: 1000 }));

    assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4]);
    assert.equal(maxActive, 1);
    assert.deepEqual(order, ['start-0', 'end-0', 'start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3', 'start-4', 'end-4']);
    assert.equal(queue.queueSnapshot().depth, 0);
});

test('TIA queue timeout aborts the operation and releases the next queued job', async () => {
    queue._resetForTests();
    let sawAbort = false;

    await assert.rejects(
        queue.enqueueTiaOp(signal => new Promise(() => {
            signal.addEventListener('abort', () => { sawAbort = true; }, { once: true });
        }), { label: '卡住的博途操作', timeoutMs: 20 }),
        error => error.code === 'TIA_QUEUE_TIMEOUT' && error.statusCode === 504 && /超时/.test(error.message)
    );

    assert.equal(sawAbort, true);
    assert.equal(await queue.enqueueTiaOp(async () => 'next-ok', { label: '后续操作', timeoutMs: 1000 }), 'next-ok');
    assert.equal(queue.queueSnapshot().depth, 0);
});

test('TIA queue rejects a duplicate in-flight key with a Chinese conflict error', async () => {
    queue._resetForTests();
    let release;
    const first = queue.enqueueTiaOp(() => new Promise(resolve => { release = resolve; }), {
        key: 'same-tool:same-args',
        label: '重复导入',
        timeoutMs: 1000,
    });

    await assert.rejects(
        queue.enqueueTiaOp(async () => 'must-not-run', { key: 'same-tool:same-args', label: '重复导入', timeoutMs: 1000 }),
        error => error.code === 'TIA_QUEUE_DUPLICATE' && error.statusCode === 409 && /相同操作/.test(error.message)
    );

    release('first-ok');
    assert.equal(await first, 'first-ok');
    assert.equal(queue.queueSnapshot().depth, 0);
});

test('expired TIA confirmations are cleaned after TTL without consuming tokens', () => {
    queue._resetForTests();
    const now = Date.now();
    for (let i = 0; i < 20; i += 1) {
        queue.issueTiaConfirmation(7, '<Document />' + i, { project: 'P' + i }, { ttlMs: 60000 });
    }

    assert.equal(queue.confirmationSnapshot().count, 20);
    assert.equal(queue.cleanupExpiredTiaConfirmations(now + 120000), 20);
    assert.equal(queue.confirmationSnapshot().count, 0);
});
