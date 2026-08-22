const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTiaConfirmation } = require('../tia-confirmation');

test('preflight facts are mapped to all confirmation fields', () => {
    const view = buildTiaConfirmation({
        tiaVersion: 'V21',
        project: '项目1',
        plc: 'PLC_1',
        blockType: 'FB',
        blockName: 'MotorControl',
        language: 'lad',
        existingCount: 12,
        nameTaken: false
    });

    assert.deepEqual(view, {
        tiaVersion: 'TIA V21',
        project: '项目1',
        plc: 'PLC_1',
        blockType: 'FB',
        blockName: 'MotorControl',
        language: 'LAD 梯形图',
        existingCount: '12',
        warning: '',
        overwrite: false
    });
});

test('same-name block requires user-selected overwrite and produces an explicit warning', () => {
    const view = buildTiaConfirmation({
        blockName: 'ExistingBlock',
        language: 'scl',
        nameTaken: true
    });

    assert.equal(view.overwrite, false);
    assert.match(view.warning, /ExistingBlock/);
    assert.match(view.warning, /覆盖/);
    assert.equal(view.language, 'SCL 结构化文本');
});
