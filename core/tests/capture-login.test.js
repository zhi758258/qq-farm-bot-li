const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
    extractLoginInfo,
    isCaptureHost,
    isValidCode,
    matchesHostPattern,
    parseHttpHead,
} = require('../dist/capture/code-extractor');
const { classifyIpv4, ipv4ToInt } = require('../dist/capture/ip-utils');
const { parsePortRange, splitList } = require('../dist/capture/config');
const { createSessionStore } = require('../dist/capture/session-store');
const {
    addCapturedValues,
    findDuplicateCapturedAccount,
    getCaptureAdvertiseHost,
    getCaptureBypassHosts,
    isCertificateTokenValid,
    isCompleteQqFriendSource,
    mergeKnownFriendGids,
    normalizeApiBase,
} = require('../dist/controllers/admin/capture-routes');

test('matchesHostPattern accepts wildcard and bare gateway hosts', () => {
    assert.equal(matchesHostPattern('gate-obt.nqf.qq.com', '*.nqf.qq.com'), true);
    assert.equal(matchesHostPattern('nqf.qq.com', '*.nqf.qq.com'), true);
    assert.equal(matchesHostPattern('q.qq.com', 'q.qq.com'), true);
    assert.equal(matchesHostPattern('example.com', '*.nqf.qq.com'), false);
});

test('isCaptureHost uses configured capture hosts', () => {
    const config = { captureHosts: ['*.nqf.qq.com', 'q.qq.com'] };
    assert.equal(isCaptureHost('gate-obt.nqf.qq.com', config), true);
    assert.equal(isCaptureHost('q.qq.com', config), true);
    assert.equal(isCaptureHost('apple.com', config), false);
});

test('isValidCode rejects noise and short tracker values', () => {
    assert.equal(isValidCode('true'), false);
    assert.equal(isValidCode('abc'), false);
    assert.equal(isValidCode('shortcode15char', { gatewayHost: false, isUpgrade: false }), false);
    assert.equal(isValidCode('gateway-code', { gatewayHost: true }), true);
    assert.equal(isValidCode('upgrade-code', { isUpgrade: true }), true);
    assert.equal(isValidCode('1234567890abcdef'), true);
});

test('extractLoginInfo reads gateway websocket code and openID', () => {
    const raw = Buffer.from('GET /prod/ws?platform=qq&code=login-code-value&openID=oid-1 HTTP/1.1\r\nHost: gate-obt.nqf.qq.com\r\nUpgrade: websocket\r\n\r\n');
    const parsed = parseHttpHead(raw);
    const info = extractLoginInfo({
        host: 'gate-obt.nqf.qq.com',
        parsedHead: parsed,
        config: { captureHosts: ['*.nqf.qq.com'], gatewayHosts: ['*.nqf.qq.com'] },
    });
    assert.equal(info.code, 'login-code-value');
    assert.equal(info.openId, 'oid-1');
    assert.equal(info.matched, true);
});

test('classifyIpv4 and parsePortRange keep a single MITM port', () => {
    assert.equal(classifyIpv4('100.64.1.2'), 'tailscale');
    assert.equal(classifyIpv4('192.168.1.8'), 'lan');
    assert.equal(classifyIpv4('8.8.8.8'), 'other');
    assert.equal(ipv4ToInt('192.168.0.1'), 0xC0A80001);
    assert.deepEqual(parsePortRange('18000-18010', 18000, 18000), { from: 18000, to: 18000 });
    assert.deepEqual(splitList('a, b,,c'), ['a', 'b', 'c']);
});

test('session store records first code and unique friend gids', () => {
    const store = createSessionStore({ config: { autoStopSec: 900, sessionTtlMs: 60_000 } });
    const session = store.createSession('s1', 'qq');
    store.addCode(session, { code: 'code-a', openId: 'oid' });
    store.addCode(session, { code: 'code-b', openId: 'oid-2' });
    store.addFriendGids(session, { gids: [11, 11, 12], source: 'gamepb.friendpb.FriendService.GetAll', complete: true });
    const snapshot = store.buildSnapshot(session);
    assert.equal(session.code, 'code-a');
    assert.equal(session.openId, 'oid');
    assert.equal(snapshot.friends.items.length, 2);
    assert.equal(snapshot.friends.complete, true);
    assert.equal(snapshot.captured, true);
});

test('mergeKnownFriendGids drops self gid and duplicates', () => {
    assert.deepEqual(mergeKnownFriendGids([11, 12], [12, 13, 11], 11), [12, 13]);
    assert.deepEqual(mergeKnownFriendGids(undefined, [0, -1, 14], 1), [14]);
});

test('findDuplicateCapturedAccount matches code or gid on the same platform', () => {
    const accounts = [
        { id: 'a1', platform: 'qq', code: 'c1', gid: '100' },
        { id: 'a2', platform: 'wx', code: 'c2', gid: '200' },
    ];
    assert.equal(findDuplicateCapturedAccount(accounts, { platform: 'qq', code: 'c1', accountGid: '' })?.id, 'a1');
    assert.equal(findDuplicateCapturedAccount(accounts, { platform: 'wx', code: '', accountGid: '200' })?.id, 'a2');
    assert.equal(findDuplicateCapturedAccount(accounts, { platform: 'qq', code: 'c1', accountGid: '' }, 'a1'), null);
});

test('certificate token comparison is length-safe', () => {
    const token = crypto.randomBytes(12).toString('base64url');
    assert.equal(isCertificateTokenValid({ certificateToken: token }, token), true);
    assert.equal(isCertificateTokenValid({ certificateToken: token }, `${token}x`), false);
    assert.equal(isCertificateTokenValid({ certificateToken: '' }, ''), false);
});

test('bypass and advertise hosts prefer public forwarded values', () => {
    const req = {
        hostname: 'localhost',
        headers: {
            'x-forwarded-host': 'farm.example.com',
            host: '127.0.0.1:3007',
            origin: 'https://farm.example.com',
            referer: 'https://farm.example.com/settings',
        },
    };
    assert.deepEqual(getCaptureBypassHosts(req).slice(0, 3), ['localhost', 'farm.example.com', '127.0.0.1']);
    assert.equal(getCaptureAdvertiseHost(req), 'farm.example.com');
});

test('normalizeApiBase keeps http(s) origins without credentials', () => {
    assert.equal(normalizeApiBase('http://127.0.0.1:8450/'), 'http://127.0.0.1:8450');
    assert.throws(() => normalizeApiBase('ftp://127.0.0.1:8450'), /仅支持/);
    assert.throws(() => normalizeApiBase('http://user:pass@127.0.0.1:8450'), /仅支持/);
});

test('complete friend sources are GetAll and SyncAll', () => {
    assert.equal(isCompleteQqFriendSource('gamepb.friendpb.FriendService.GetAll'), true);
    assert.equal(isCompleteQqFriendSource('gamepb.friendpb.FriendService.SyncAll'), true);
    assert.equal(isCompleteQqFriendSource('gamepb.friendpb.FriendService.GetGameFriends'), false);
});

test('addCapturedValues records code, gid and complete friend list', () => {
    const flow = {
        platform: 'qq',
        code: '',
        accountGid: '',
        openId: '',
        friendGids: new Set(),
        friendSource: '',
        friendListComplete: false,
        publicInfo: {},
        proxy: {},
        captureStatus: 'idle',
    };
    addCapturedValues(flow, {
        data: {
            channels: {
                qq: {
                    status: 'captured',
                    codes: [{ code: 'code-1', gid: '1001', openid: 'oid-1' }],
                },
            },
            friends: {
                source: 'gamepb.friendpb.FriendService.GetAll',
                items: [{ gid: '21' }, { gid: '22' }],
            },
            publicInfo: { host: '10.0.0.2' },
            proxy: { running: true },
        },
    });
    assert.equal(flow.code, 'code-1');
    assert.equal(flow.accountGid, '1001');
    assert.equal(flow.openId, 'oid-1');
    assert.deepEqual([...flow.friendGids], [21, 22]);
    assert.equal(flow.friendListComplete, true);
    assert.equal(flow.captureStatus, 'captured');
});
