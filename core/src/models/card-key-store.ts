export {};
const fs = require('node:fs');
const crypto = require('node:crypto');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');

const CARD_KEYS_FILE: string = getDataFile('card-keys.json');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface CardKeyRecord {
    id: string;
    code: string;
    days: number;
    description: string;
    used: boolean;
    usedBy: string;
    usedAt: number;
    createdAt: number;
}

interface CardKeysData {
    claimEnabled: boolean;
    keys: CardKeyRecord[];
    nextId: number;
}

interface PublicCardKey {
    id: string;
    code: string;
    days: number;
    description: string;
    used: boolean;
    usedBy: string;
    usedAt: number;
    createdAt: number;
}

let cache: CardKeysData | null = null;

function normalizeCode(raw: unknown): string {
    return String(raw || '').trim().toUpperCase();
}

function generateCode(): string {
    return crypto.randomBytes(8).toString('hex').toUpperCase();
}

function normalizeCardKey(raw: any): CardKeyRecord | null {
    if (!raw || typeof raw !== 'object') return null;
    const code = normalizeCode(raw.code);
    const days = Number(raw.days);
    if (!code || !Number.isFinite(days) || days < 1) return null;
    return {
        id: String(raw.id || '').trim(),
        code,
        days: Math.floor(days),
        description: String(raw.description || '').trim(),
        used: raw.used === true,
        usedBy: String(raw.usedBy || '').trim(),
        usedAt: Number(raw.usedAt) || 0,
        createdAt: Number(raw.createdAt) || Date.now(),
    };
}

function normalizeCardKeysData(raw: unknown): CardKeysData {
    const data: any = raw && typeof raw === 'object' ? raw : {};
    const keys = (Array.isArray(data.keys) ? data.keys : []).map(normalizeCardKey).filter(Boolean) as CardKeyRecord[];
    const maxId = keys.reduce((max, key) => {
        const n = Number.parseInt(String(key.id || '').replace(/^k_/, ''), 10);
        return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 0);
    let nextId = Number.parseInt(data.nextId, 10);
    if (!Number.isFinite(nextId) || nextId <= 0) nextId = maxId + 1;
    if (nextId <= maxId) nextId = maxId + 1;
    return {
        claimEnabled: data.claimEnabled === true,
        keys,
        nextId,
    };
}

function saveCardKeys(data: CardKeysData): void {
    ensureDataDir();
    cache = normalizeCardKeysData(data);
    fs.writeFileSync(CARD_KEYS_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

function loadCardKeys(): CardKeysData {
    if (cache) return cache;
    ensureDataDir();
    try {
        if (fs.existsSync(CARD_KEYS_FILE)) {
            cache = normalizeCardKeysData(JSON.parse(fs.readFileSync(CARD_KEYS_FILE, 'utf8')));
            return cache;
        }
    } catch {
        cache = null;
    }
    cache = { claimEnabled: false, keys: [], nextId: 1 };
    return cache;
}

function unusedKeys(): CardKeyRecord[] {
    return loadCardKeys().keys.filter(key => !key.used);
}

function toPublicCardKey(key: CardKeyRecord): PublicCardKey {
    return {
        id: key.id,
        code: key.code,
        days: key.days,
        description: key.description,
        used: key.used,
        usedBy: key.usedBy,
        usedAt: key.usedAt,
        createdAt: key.createdAt,
    };
}

function getPublicClaimStatus(): { claimEnabled: boolean; stock: number } {
    const data = loadCardKeys();
    return {
        claimEnabled: data.claimEnabled === true,
        stock: unusedKeys().length,
    };
}

function listCardKeys(): { claimEnabled: boolean; stock: number; keys: PublicCardKey[] } {
    const data = loadCardKeys();
    return {
        claimEnabled: data.claimEnabled === true,
        stock: unusedKeys().length,
        keys: data.keys.slice().sort((a, b) => b.createdAt - a.createdAt).map(toPublicCardKey),
    };
}

function setClaimEnabled(enabled: boolean): { claimEnabled: boolean; stock: number } {
    const data = loadCardKeys();
    data.claimEnabled = enabled === true;
    saveCardKeys(data);
    return getPublicClaimStatus();
}

function createCardKeys(input: { count?: number; days?: number; description?: string }): { ok: true; keys: PublicCardKey[] } | { ok: false; status: number; error: string } {
    const count = Number(input?.count);
    const days = Number(input?.days);
    if (!Number.isFinite(count) || !Number.isInteger(count) || count < 1 || count > 200) {
        return { ok: false, status: 400, error: '创建数量必须是 1 到 200 的整数' };
    }
    if (!Number.isFinite(days) || !Number.isInteger(days) || days < 1 || days > 3650) {
        return { ok: false, status: 400, error: '天数必须是 1 到 3650 的整数' };
    }
    const description = String(input?.description || '').trim() || `${days}天卡`;
    const data = loadCardKeys();
    const existing = new Set(data.keys.map(key => key.code));
    const created: CardKeyRecord[] = [];
    const now = Date.now();
    for (let i = 0; i < count; i++) {
        let code = generateCode();
        let guard = 0;
        while (existing.has(code) && guard < 8) {
            code = generateCode();
            guard++;
        }
        if (existing.has(code)) return { ok: false, status: 500, error: '卡密生成失败，请重试' };
        existing.add(code);
        const record: CardKeyRecord = {
            id: `k_${data.nextId++}`,
            code,
            days,
            description,
            used: false,
            usedBy: '',
            usedAt: 0,
            createdAt: now + i,
        };
        data.keys.push(record);
        created.push(record);
    }
    saveCardKeys(data);
    return { ok: true, keys: created.map(toPublicCardKey) };
}

function peekCardKey(codeInput: string): { ok: true; days: number; description: string } | { ok: false; status: number; error: string } {
    const code = normalizeCode(codeInput);
    if (!code) return { ok: false, status: 400, error: '请输入卡密' };
    const key = loadCardKeys().keys.find(item => item.code === code);
    if (!key || key.used) return { ok: false, status: 400, error: '卡密无效或已使用' };
    return { ok: true, days: key.days, description: key.description };
}

function claimCardKey(): { ok: true; code: string; days: number; description: string } | { ok: false; status: number; error: string } {
    const data = loadCardKeys();
    if (!data.claimEnabled) return { ok: false, status: 403, error: '卡密领取未开启' };
    const available = unusedKeys()[0];
    if (!available) return { ok: false, status: 409, error: '暂无可领取卡密' };
    return {
        ok: true,
        code: available.code,
        days: available.days,
        description: available.description,
    };
}

function consumeCardKey(codeInput: string, userId: string): { ok: true; days: number; description: string } | { ok: false; status: number; error: string } {
    const code = normalizeCode(codeInput);
    if (!code) return { ok: false, status: 400, error: '请输入卡密' };
    const data = loadCardKeys();
    const key = data.keys.find(item => item.code === code);
    if (!key || key.used) return { ok: false, status: 400, error: '卡密无效或已使用' };
    key.used = true;
    key.usedBy = String(userId || '').trim();
    key.usedAt = Date.now();
    saveCardKeys(data);
    return { ok: true, days: key.days, description: key.description };
}

function daysToExpiresAt(days: number, from: number = Date.now()): number {
    return from + Math.floor(days) * MS_PER_DAY;
}

module.exports = {
    MS_PER_DAY,
    getPublicClaimStatus,
    listCardKeys,
    setClaimEnabled,
    createCardKeys,
    peekCardKey,
    claimCardKey,
    consumeCardKey,
    daysToExpiresAt,
};
