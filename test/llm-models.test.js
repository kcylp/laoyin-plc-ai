const assert = require('node:assert/strict');
const test = require('node:test');

const {
    init,
    listUserModels,
    probeChatModel,
    formatProviderError,
} = require('../llm');

function fakeDb({ providers, modelsByProvider }) {
    return {
        prepare(sql) {
            return {
                all(arg) {
                    if (/SELECT \* FROM ai_providers WHERE user_id = \? ORDER BY id/.test(sql)) return providers;
                    if (/SELECT \* FROM ai_models WHERE provider_id = \? AND enabled = 1 ORDER BY id/.test(sql)) {
                        return modelsByProvider[arg] || [];
                    }
                    throw new Error('unexpected all SQL: ' + sql);
                },
            };
        },
    };
}

test('custom provider with no enabled models does not fall back to built-in models', () => {
    init(fakeDb({ providers: [{ id: 4, name: 'My Codex' }], modelsByProvider: { 4: [] } }), 'test-secret');

    assert.deepEqual(listUserModels(1), []);
});

test('custom enabled models remain the user model list', () => {
    init(fakeDb({
        providers: [{ id: 4, name: 'My Codex' }],
        modelsByProvider: { 4: [{ model_id: 'gpt5.6-sol', label: 'GPT 5.6 Sol' }] },
    }), 'test-secret');

    assert.deepEqual(listUserModels(1), [{
        id: 'db4/gpt5.6-sol',
        provider: 'My Codex',
        model: 'gpt5.6-sol',
        label: 'My Codex · GPT 5.6 Sol',
    }]);
});

test('chat probe rejects a model that is listed but has no distributor channel', async () => {
    const calls = [];
    const result = await probeChatModel({
        baseUrl: 'https://relay.example/v1',
        apiKey: 'test-key',
        wireApi: 'openai',
        model: 'gpt5.6-sol',
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return {
                ok: false,
                status: 400,
                async json() {
                    return {
                        error: {
                            message: 'No available channel for model gpt5.6-sol under group GTP-PRO号池 (distributor)',
                        },
                    };
                },
            };
        },
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /gpt5\.6-sol/);
    assert.match(result.message, /GTP-PRO号池/);
    assert.match(result.message, /没有可用聊天通道/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://relay.example/v1/chat/completions');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, 'gpt5.6-sol');
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 1);
});

test('provider channel errors are localized without hiding model and pool names', () => {
    const message = formatProviderError(
        'My Codex',
        'No available channel for model gpt5.6-sol under group GTP-PRO号池 (distributor) (request id: req-123)'
    );

    assert.match(message, /^\[My Codex\]/);
    assert.match(message, /gpt5\.6-sol/);
    assert.match(message, /GTP-PRO号池/);
    assert.match(message, /没有可用聊天通道/);
    assert.doesNotMatch(message, /No available channel/);
});
