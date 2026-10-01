export {};
const fs = require('node:fs');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const security = require('./auth-security');
const adminStore = require('./admin-store');
const store = require('./store');
const cardKeyStore = require('./card-key-store');

const USERS_FILE: string = getDataFile('users.json');
const DEFAULT_USER_QUOTA = 99;
const ADMIN_USER_ID = 'admin';

interface UserRecord {
    id: string;
    username: string;
    password: string;
    role: 'user';
    quota: number;
    enabled: boolean;
    expiresAt: number;
    createdAt: number;
    updatedAt: number;
}

interface UsersData {
    users: UserRecord[];
    nextId: number;
}

interface PublicUser {
    id: string;
    username: string;
    role: 'admin' | 'user';
    quota: number | null;
    usedQuota: number;
    enabled: boolean;
    expiresAt: number | null;
    createdAt?: number;
    mustChangePassword?: boolean;
}

let cache: UsersData | null = null;

function validateUsername(username: string): { valid: boolean; error?: string } {
    const name = String(username || '').trim();
    if (!name) return { valid: false, error: '请输入用户名' };
    if (name.length < 3) return { valid: false, error: '用户名至少3位' };
    if (name.length > 32) return { valid: false, error: '用户名最多32位' };
    if (!/^\w+$/.test(name)) return { valid: false, error: '用户名只能包含字母、数字、下划线' };
    return { valid: true };
}

function normalizeUser(raw: any): UserRecord | null {
    if (!raw || typeof raw !== 'object') return null;
    const username = String(raw.username || '').trim();
    const password = String(raw.password || '');
    if (!username || !password) return null;
    const quota = Number(raw.quota);
    return {
        id: String(raw.id || '').trim(),
        username,
        password,
        role: 'user',
        quota: Number.isFinite(quota) && quota >= 0 ? Math.floor(quota) : DEFAULT_USER_QUOTA,
        enabled: raw.enabled !== false,
        expiresAt: Number(raw.expiresAt) || 0,
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now(),
    };
}

function normalizeUsersData(raw: unknown): UsersData {
    const data: any = raw && typeof raw === 'object' ? raw : {};
    const users = (Array.isArray(data.users) ? data.users : []).map(normalizeUser).filter(Boolean) as UserRecord[];
    const maxId = users.reduce((m, u) => {
        const n = Number.parseInt(String(u.id || '').replace(/^u_/, ''), 10);
        return Number.isFinite(n) ? Math.max(m, n) : m;
    }, 0);
    let nextId = Number.parseInt(data.nextId, 10);
    if (!Number.isFinite(nextId) || nextId <= 0) nextId = maxId + 1;
    if (nextId <= maxId) nextId = maxId + 1;
    return { users, nextId };
}

function saveUsers(data: UsersData): void {
    ensureDataDir();
    cache = normalizeUsersData(data);
    fs.writeFileSync(USERS_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

function loadUsers(): UsersData {
    if (cache) return cache;
    ensureDataDir();
    try {
        if (fs.existsSync(USERS_FILE)) {
            cache = normalizeUsersData(JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')));
            return cache;
        }
    } catch {
        cache = null;
    }
    cache = { users: [], nextId: 1 };
    return cache;
}

function countOwnedAccounts(userId: string): number {
    const ownerId = String(userId || '').trim();
    if (!ownerId) return 0;
    const accounts = store.getAccounts ? store.getAccounts().accounts : [];
    if (!Array.isArray(accounts)) return 0;
    return accounts.filter((account: any) => String(account.ownerId || 'admin') === ownerId).length;
}

function getAdminUsername(): string {
    try {
        return String(adminStore.getAdminInfo()?.username || 'admin').trim() || 'admin';
    } catch {
        return 'admin';
    }
}

function usernameExists(username: string, excludeUserId: string = ''): boolean {
    const name = String(username || '').trim();
    if (!name) return false;
    if (name === getAdminUsername() && excludeUserId !== ADMIN_USER_ID) return true;
    return loadUsers().users.some(user => user.username === name && user.id !== excludeUserId);
}

function toPublicUser(user: UserRecord): PublicUser {
    return {
        id: user.id,
        username: user.username,
        role: 'user',
        quota: user.quota,
        usedQuota: countOwnedAccounts(user.id),
        enabled: user.enabled,
        expiresAt: user.expiresAt || 0,
        createdAt: user.createdAt,
    };
}

function getAdminPublicInfo(): PublicUser {
    const info = adminStore.getAdminInfo();
    return {
        id: ADMIN_USER_ID,
        username: info.username,
        role: 'admin',
        quota: null,
        usedQuota: countOwnedAccounts(ADMIN_USER_ID),
        enabled: true,
        expiresAt: null,
        mustChangePassword: info.mustChangePassword === true,
    };
}

function findUserById(userId: string): UserRecord | null {
    const id = String(userId || '').trim();
    if (!id) return null;
    return loadUsers().users.find(user => user.id === id) || null;
}

function findUserByUsername(username: string): UserRecord | null {
    const name = String(username || '').trim();
    if (!name) return null;
    return loadUsers().users.find(user => user.username === name) || null;
}

function isUserExpired(user: UserRecord, now: number = Date.now()): boolean {
    return Number(user.expiresAt) > 0 && Number(user.expiresAt) <= now;
}

function registerUser(username: string, password: string, cardKey: string = ''): { ok: true; user: PublicUser } | { ok: false; status: number; error: string } {
    const nameCheck = validateUsername(username);
    if (!nameCheck.valid) return { ok: false, status: 400, error: nameCheck.error || '用户名不合法' };
    const strength = security.validatePasswordStrength(String(password || ''));
    if (!strength.valid) return { ok: false, status: 400, error: strength.errors.join('；') };
    const name = String(username).trim();
    if (usernameExists(name)) return { ok: false, status: 409, error: '用户名已被使用' };
    const peek = cardKeyStore.peekCardKey(cardKey);
    if (!peek.ok) return peek;

    const data = loadUsers();
    const now = Date.now();
    const user: UserRecord = {
        id: `u_${data.nextId++}`,
        username: name,
        password: security.hashPassword(String(password)),
        role: 'user',
        quota: DEFAULT_USER_QUOTA,
        enabled: true,
        expiresAt: cardKeyStore.daysToExpiresAt(peek.days, now),
        createdAt: now,
        updatedAt: now,
    };
    data.users.push(user);
    saveUsers(data);
    const consumed = cardKeyStore.consumeCardKey(cardKey, user.id);
    if (!consumed.ok) {
        data.users = data.users.filter(item => item.id !== user.id);
        saveUsers(data);
        return consumed;
    }
    return { ok: true, user: toPublicUser(user) };
}

function validateUser(username: string, password: string, ip: string = 'unknown'): any {
    security.loadLoginAttempts();
    const rateLimit = security.checkRateLimit(ip);
    if (!rateLimit.allowed) return { error: 'rate_limit', ...rateLimit };

    const name = String(username || '').trim();
    const lockout = security.checkUserLockout(name);
    if (lockout.locked) return { error: 'locked', ...lockout };

    const user = findUserByUsername(name);
    if (!user || !security.verifyPassword(String(password || ''), user.password)) {
        const attempt = security.recordFailedAttempt(name);
        return attempt.locked
            ? { error: 'locked', message: attempt.message }
            : { error: 'invalid_credentials', message: `用户名或密码错误，剩余尝试次数: ${attempt.remainingAttempts}` };
    }
    if (!user.enabled) return { error: 'disabled', message: '账号已被禁用' };
    if (isUserExpired(user)) return { error: 'expired', message: '账号已过期' };

    security.clearFailedAttempts(name);
    if (security.needsRehash(user.password)) {
        user.password = security.hashPassword(String(password));
        user.updatedAt = Date.now();
        const data = loadUsers();
        const idx = data.users.findIndex(item => item.id === user.id);
        if (idx >= 0) data.users[idx] = user;
        saveUsers(data);
    }
    return toPublicUser(user);
}

function getPublicUser(userId: string): PublicUser | null {
    if (String(userId || '') === ADMIN_USER_ID) return getAdminPublicInfo();
    const user = findUserById(userId);
    return user ? toPublicUser(user) : null;
}

function listUsers(): PublicUser[] {
    return loadUsers().users.map(toPublicUser);
}

function updateQuota(userId: string, quota: number): { ok: true; user: PublicUser } | { ok: false; status: number; error: string } {
    const user = findUserById(userId);
    if (!user) return { ok: false, status: 404, error: '用户不存在' };
    const nextQuota = Number(quota);
    if (!Number.isFinite(nextQuota) || nextQuota < 0 || !Number.isInteger(nextQuota)) {
        return { ok: false, status: 400, error: '额度必须是非负整数' };
    }
    const used = countOwnedAccounts(user.id);
    if (nextQuota < used) return { ok: false, status: 400, error: '额度不能小于已绑定账号数' };
    user.quota = nextQuota;
    user.updatedAt = Date.now();
    const data = loadUsers();
    const idx = data.users.findIndex(item => item.id === user.id);
    if (idx >= 0) data.users[idx] = user;
    saveUsers(data);
    return { ok: true, user: toPublicUser(user) };
}

function setUserEnabled(userId: string, enabled: boolean): { ok: true; user: PublicUser } | { ok: false; status: number; error: string } {
    const user = findUserById(userId);
    if (!user) return { ok: false, status: 404, error: '用户不存在' };
    user.enabled = enabled === true;
    user.updatedAt = Date.now();
    const data = loadUsers();
    const idx = data.users.findIndex(item => item.id === user.id);
    if (idx >= 0) data.users[idx] = user;
    saveUsers(data);
    return { ok: true, user: toPublicUser(user) };
}

function changeUserPassword(userId: string, oldPassword: string, newPassword: string): { ok: boolean; error?: string; message?: string } {
    const user = findUserById(userId);
    if (!user) return { ok: false, error: '用户不存在' };
    if (!security.verifyPassword(String(oldPassword || ''), user.password)) return { ok: false, error: '当前密码错误' };
    const validation = security.validatePasswordStrength(String(newPassword || ''));
    if (!validation.valid) return { ok: false, error: validation.errors.join('；') };
    user.password = security.hashPassword(String(newPassword));
    user.updatedAt = Date.now();
    const data = loadUsers();
    const idx = data.users.findIndex(item => item.id === user.id);
    if (idx >= 0) data.users[idx] = user;
    saveUsers(data);
    return { ok: true, message: '密码修改成功' };
}

function canAddGameAccount(userId: string, role: 'admin' | 'user'): { ok: true } | { ok: false; error: string } {
    if (role === 'admin') return { ok: true };
    const user = findUserById(userId);
    if (!user) return { ok: false, error: '用户不存在' };
    if (countOwnedAccounts(user.id) >= user.quota) {
        return { ok: false, error: '额度不足，无法添加更多游戏账号' };
    }
    return { ok: true };
}

module.exports = {
    ADMIN_USER_ID,
    DEFAULT_USER_QUOTA,
    validateUsername,
    usernameExists,
    countOwnedAccounts,
    registerUser,
    validateUser,
    getPublicUser,
    getAdminPublicInfo,
    listUsers,
    updateQuota,
    setUserEnabled,
    changeUserPassword,
    canAddGameAccount,
    findUserById,
    findUserByUsername,
    isUserExpired,
};
