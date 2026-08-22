const test = require('node:test');
const assert = require('node:assert/strict');

const { extractUserId, decideAction } = require('../mail-watcher');

test('extractUserId reads userId from subject and body', () => {
    assert.equal(extractUserId({ subject: '【新用户待审批】张三（userId=42）', text: '' }), 42);
    assert.equal(extractUserId({ subject: 'Re: 审批', text: '链接 /api/approve?userId=7' }), 7);
    assert.equal(extractUserId({ subject: 'Re: 审批', text: '正文 userId: 9' }), 9);
    assert.equal(extractUserId({ subject: '普通邮件', text: '没有用户ID' }), null);
});

test('decideAction prefers rejection over approval (不同意 contains 同意)', () => {
    assert.equal(decideAction('不同意'), 'reject');
    assert.equal(decideAction('我不同意这个人'), 'reject');
    assert.equal(decideAction('reject'), 'reject');
    assert.equal(decideAction('拒绝'), 'reject');
    assert.equal(decideAction('同意'), 'approve');
    assert.equal(decideAction('approve'), 'approve');
    assert.equal(decideAction('通过'), 'approve');
});

test('decideAction ignores approval/reject URLs pasted in the reply', () => {
    // 老板把审批链接粘进回复（链接本身含 approve/reject 字样）不应误判
    assert.equal(decideAction('reject，不同意这个人 /api/approve?userId=2'), 'reject');
    assert.equal(decideAction('点了链接 http://localhost:3000/api/approve?userId=2&action=approve'), null);
    assert.equal(decideAction('这是审批链接：/api/approve?userId=2'), null);
});

test('decideAction returns null for unrelated mail', () => {
    assert.equal(decideAction('随便聊聊'), null);
    assert.equal(decideAction(''), null);
    assert.equal(decideAction('你好，在吗'), null);
});
