const test = require('node:test');
const assert = require('node:assert/strict');

const userStore = require('../dist/models/user-store');
const cardKeyStore = require('../dist/models/card-key-store');

function uniqueName(prefix) {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

test('registerUser rejects missing card key', () => {
    const result = userStore.registerUser(uniqueName('nocard'), 'Test1234', '');
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.error, '请输入卡密');
});

test('registerUser consumes time card and sets expiresAt', () => {
    const createdKeys = cardKeyStore.createCardKeys({ count: 1, days: 7, description: '7天卡' });
    assert.equal(createdKeys.ok, true);
    const code = createdKeys.keys[0].code;
    const before = Date.now();
    const result = userStore.registerUser(uniqueName('cardok'), 'Test1234', code);
    assert.equal(result.ok, true);
    assert.ok(result.user.expiresAt >= before + 7 * cardKeyStore.MS_PER_DAY - 1000);
    const reused = userStore.registerUser(uniqueName('cardreuse'), 'Test1234', code);
    assert.equal(reused.ok, false);
    assert.equal(reused.error, '卡密无效或已使用');
});

test('invalid username keeps card key unused', () => {
    const createdKeys = cardKeyStore.createCardKeys({ count: 1, days: 3, description: '3天卡' });
    assert.equal(createdKeys.ok, true);
    const code = createdKeys.keys[0].code;
    const failed = userStore.registerUser('ab', 'Test1234', code);
    assert.equal(failed.ok, false);
    const peek = cardKeyStore.peekCardKey(code);
    assert.equal(peek.ok, true);
});

test('claim is blocked when switch is off', () => {
    cardKeyStore.setClaimEnabled(false);
    const claimed = cardKeyStore.claimCardKey();
    assert.equal(claimed.ok, false);
    assert.equal(claimed.status, 403);
});

test('claim returns unused key without consuming it', () => {
    const createdKeys = cardKeyStore.createCardKeys({ count: 1, days: 10, description: '10天卡' });
    assert.equal(createdKeys.ok, true);
    cardKeyStore.setClaimEnabled(true);
    const claimed = cardKeyStore.claimCardKey();
    assert.equal(claimed.ok, true);
    assert.ok(claimed.code);
    const peek = cardKeyStore.peekCardKey(claimed.code);
    assert.equal(peek.ok, true);
    cardKeyStore.setClaimEnabled(false);
});
