const test = require('node:test');
const assert = require('node:assert/strict');

const userStore = require('../dist/models/user-store');
const cardKeyStore = require('../dist/models/card-key-store');
const accounts = require('../dist/models/store/accounts');

function uniqueName(prefix) {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

function registerWithCard(username, password, days = 30) {
    const createdKeys = cardKeyStore.createCardKeys({ count: 1, days, description: `${days}天卡` });
    assert.equal(createdKeys.ok, true);
    return userStore.registerUser(username, password, createdKeys.keys[0].code);
}

test('registerUser assigns quota 99 and role user', () => {
    const username = uniqueName('alice');
    const result = registerWithCard(username, 'Test1234');
    assert.equal(result.ok, true);
    assert.equal(result.user.role, 'user');
    assert.equal(result.user.quota, 99);
    assert.equal(result.user.usedQuota, 0);
    assert.equal(result.user.enabled, true);
    assert.equal(result.user.username, username);
});

test('registerUser rejects duplicate username', () => {
    const username = uniqueName('bob');
    const first = registerWithCard(username, 'Test1234');
    assert.equal(first.ok, true);
    const second = registerWithCard(username, 'Test1234');
    assert.equal(second.ok, false);
    assert.equal(second.status, 409);
    assert.equal(second.error, '用户名已被使用');
});

test('registerUser rejects reserved admin username', () => {
    const result = registerWithCard('admin', 'Test1234');
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
});

test('registerUser rejects illegal username', () => {
    const shortName = registerWithCard('ab', 'Test1234');
    assert.equal(shortName.ok, false);
    assert.equal(shortName.status, 400);

    const badChars = userStore.registerUser('bad name', 'Test1234');
    assert.equal(badChars.ok, false);
    assert.equal(badChars.status, 400);
});

test('registerUser rejects weak password', () => {
    const result = registerWithCard(uniqueName('weak'), 'aaaaaa');
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
});

test('canAddGameAccount allows admin without quota check', () => {
    const result = userStore.canAddGameAccount('admin', 'admin');
    assert.equal(result.ok, true);
});

test('canAddGameAccount blocks user after quota is filled', () => {
    const username = uniqueName('quota');
    const created = registerWithCard(username, 'Test1234');
    assert.equal(created.ok, true);
    const userId = created.user.id;
    const lowered = userStore.updateQuota(userId, 1);
    assert.equal(lowered.ok, true);

    accounts.addOrUpdateAccount({ name: uniqueName('acc'), ownerId: userId, code: 'code' });
    const blocked = userStore.canAddGameAccount(userId, 'user');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, '额度不足，无法添加更多游戏账号');
});

test('updateQuota rejects value below used count', () => {
    const username = uniqueName('used');
    const created = registerWithCard(username, 'Test1234');
    assert.equal(created.ok, true);
    accounts.addOrUpdateAccount({ name: uniqueName('acc'), ownerId: created.user.id, code: 'code' });
    const result = userStore.updateQuota(created.user.id, 0);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.error, '额度不能小于已绑定账号数');
});

test('disabled user cannot login', () => {
    const username = uniqueName('disabled');
    const created = registerWithCard(username, 'Test1234');
    assert.equal(created.ok, true);
    const disabled = userStore.setUserEnabled(created.user.id, false);
    assert.equal(disabled.ok, true);
    const login = userStore.validateUser(username, 'Test1234', '127.0.0.1');
    assert.equal(login.error, 'disabled');
});

test('expired user cannot login', () => {
    const username = uniqueName('expired');
    const created = registerWithCard(username, 'Test1234', 1);
    assert.equal(created.ok, true);
    const user = userStore.findUserByUsername(username);
    user.expiresAt = Date.now() - 1;
    const login = userStore.validateUser(username, 'Test1234', '127.0.0.1');
    assert.equal(login.error, 'expired');
});

test('legacy accounts without ownerId belong to admin', () => {
    const data = accounts.normalizeAccountsData({
        accounts: [{ id: '1', name: 'old', code: '', platform: 'qq' }],
        nextId: 2,
    });
    assert.equal(data.accounts[0].ownerId, 'admin');
});
