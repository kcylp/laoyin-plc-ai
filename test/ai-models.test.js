const assert = require('node:assert/strict');
const test = require('node:test');

const {
    normalizeSelectedModels,
    getWorkbenchModelId,
    prioritizeSelectedModels,
    getInitialModelId,
} = require('../ai-models');

test('selected models are enabled and preserve provider context length aliases', () => {
    assert.deepEqual(normalizeSelectedModels([
        { id: 'gpt-main', label: 'GPT Main', contextLength: 1048576 },
        { id: 'gpt-fast', context_length: 131072, enabled: false },
    ]), [
        { id: 'gpt-main', label: 'GPT Main', context_length: 1048576, enabled: 1 },
        { id: 'gpt-fast', label: 'gpt-fast', context_length: 131072, enabled: 1 },
    ]);
});

test('selected models reject blanks and deduplicate by model id', () => {
    assert.deepEqual(normalizeSelectedModels([
        null,
        { id: ' ' },
        { id: 'same', label: 'First' },
        { id: 'same', label: 'Second' },
    ]), [
        { id: 'same', label: 'First', context_length: null, enabled: 1 },
    ]);
});

test('first saved provider model becomes the workbench selection', () => {
    assert.equal(getWorkbenchModelId(7, [
        { id: 'gpt-5.6-sol' },
        { id: 'gpt-fast' },
    ]), 'db7/gpt-5.6-sol');
    assert.equal(getWorkbenchModelId(7, []), null);
    assert.equal(getWorkbenchModelId('', [{ id: 'gpt-5.6-sol' }]), null);
});

test('last explicitly selected model is saved first for the workbench default', () => {
    assert.deepEqual(prioritizeSelectedModels([
        { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
        { id: 'gpt5.6-sol', label: 'GPT 5.6 Sol' },
    ], 'gpt5.6-sol'), [
        { id: 'gpt5.6-sol', label: 'GPT 5.6 Sol', context_length: null, enabled: 1 },
        { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', context_length: null, enabled: 1 },
    ]);
});

test('a fresh model preview selects the first available ordinary model', () => {
    assert.equal(getInitialModelId([
        { id: 'gpt5.6-sol' },
        { id: 'deepseek-v4-flash' },
    ], [], ''), 'gpt5.6-sol');
});

test('saved or previously enabled model wins over preview ordering', () => {
    const models = [{ id: 'gpt5.6-sol' }, { id: 'deepseek-v4-flash' }];
    assert.equal(getInitialModelId(models, ['deepseek-v4-flash'], ''), 'deepseek-v4-flash');
    assert.equal(getInitialModelId(models, ['deepseek-v4-flash'], 'gpt5.6-sol'), 'gpt5.6-sol');
});
