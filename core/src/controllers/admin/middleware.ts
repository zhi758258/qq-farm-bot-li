import type { NextFunction, Request, Response } from 'express';
import type { AdminContext, Session } from './context';
export {};

const crypto = require('node:crypto');
const store = require('../../models/store');
const { normalizeAccountRef, resolveAccountId } = require('../../services/account-resolver');

interface AuthenticatedRequest extends Request {
    adminToken?: string;
    auth?: Session;
}

function getClientIp(req: Request): string {
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return String(cfIp).trim();
    const realIp = req.headers['x-real-ip'];
    if (realIp) return String(realIp).trim();
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const first = String(forwarded).split(',').map(item => item.trim()).find(Boolean);
        if (first) return first;
    }
    const address = req.ip || (req as any).connection?.remoteAddress || req.socket?.remoteAddress;
    return String(address || 'unknown').replace(/^::ffff:/, '');
}

const issueToken = (): string => crypto.randomBytes(24).toString('hex');

function getRequestSession(req: Request): Session | null {
    return (req as AuthenticatedRequest).auth || null;
}

function createAuthRequired(ctx: AdminContext) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
        const token = String(req.headers['x-admin-token'] || '');
        const session = token ? ctx.tokens.get(token) : null;
        if (!token || !session) {
            res.status(401).json({ ok: false, error: 'Unauthorized' });
            return;
        }
        req.adminToken = token;
        req.auth = session;
        next();
    };
}

function createAdminRequired() {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
        if (!req.auth || req.auth.role !== 'admin') {
            res.status(403).json({ ok: false, error: '无权限' });
            return;
        }
        next();
    };
}

function revokeUserSessions(ctx: AdminContext, userId: string): void {
    const id = String(userId || '');
    for (const [token, session] of ctx.tokens.entries()) {
        if (session.userId === id) ctx.tokens.delete(token);
    }
}

function accountOwnerId(account: any): string {
    return String(account?.ownerId || 'admin').trim() || 'admin';
}

function canAccessAccount(session: Session | null | undefined, account: any): boolean {
    if (!session) return false;
    if (session.role === 'admin') return true;
    return accountOwnerId(account) === session.userId;
}

function getAllAccounts(ctx: AdminContext): any[] {
    try {
        if (ctx.provider && typeof ctx.provider.getAccounts === 'function') {
            const data = ctx.provider.getAccounts();
            if (Array.isArray(data?.accounts)) return data.accounts;
        }
    } catch {
        // Fall back to persistent storage.
    }
    const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
    return Array.isArray(data.accounts) ? data.accounts : [];
}

function getAccountList(ctx: AdminContext, req?: Request): any[] {
    const accounts = getAllAccounts(ctx);
    const session = req ? getRequestSession(req) : null;
    if (!session || session.role === 'admin') return accounts;
    return accounts.filter(account => canAccessAccount(session, account));
}

function getAccountIds(ctx: AdminContext, req?: Request): string[] {
    return getAccountList(ctx, req).map((account: any) => String(account.id || '')).filter(Boolean);
}

const isSoftRuntimeError = (err: any): boolean => {
    const message = String(typeof err === 'string' ? err : err?.message || '');
    return message === '账号未运行' || message === 'API Timeout';
};

function isGatewayProtocolError(err: any): boolean {
    const message = String(typeof err === 'string' ? err : err?.message || '').trim();
    return String(err?.name || '') === 'GatewayError'
        || typeof err?.errorMessage === 'string'
        || typeof err?.error_message === 'string'
        || /^(?:[\w-]+\.)+[\w-]+(?:\s+(?:\S.*?)??)?\bcode=\d+(?:\s|$)/.test(message);
}

function getProtocolErrorMessage(err: any): string {
    const direct = String(err?.errorMessage || err?.error_message || '').trim();
    if (direct) return direct;

    const message = String(typeof err === 'string' ? err : err?.message || '').trim();
    if (!isGatewayProtocolError(err)) return '';
    return message.match(/\bcode=\d+\b\s*(.*)$/)?.[1]?.trim() || '';
}

function handleApiError(res: Response, err: any): void {
    const protocolMessage = getProtocolErrorMessage(err);
    const payload: any = {
        ok: false,
        error: protocolMessage || (typeof err === 'string' ? err : err?.message) || 'Unknown error',
    };
    if (protocolMessage) payload.errorMessage = protocolMessage;
    const errorCode = Number(err?.code);
    if (Number.isFinite(errorCode) && errorCode !== 0) payload.errorCode = errorCode;
    if (isSoftRuntimeError(err) || isGatewayProtocolError(err)) {
        res.json(payload);
        return;
    }
    res.status(500).json(payload);
}

function resolveAccId(ctx: AdminContext, rawRef: any, req?: Request): string {
    const input = normalizeAccountRef(rawRef);
    if (!input) return '';
    const visible = getAccountList(ctx, req);
    if (ctx.provider && typeof ctx.provider.resolveAccountId === 'function') {
        const resolvedByProvider = normalizeAccountRef(ctx.provider.resolveAccountId(input));
        if (resolvedByProvider) {
            const owned = visible.find((account: any) => String(account.id || '') === resolvedByProvider);
            return owned ? resolvedByProvider : '';
        }
    }
    return resolveAccountId(visible, input) || '';
}

function getAccId(ctx: AdminContext, req: Request): string {
    return resolveAccId(ctx, req.headers['x-account-id'], req);
}

function buildKnownFriendGidSettings(accountId: string): {
    knownFriendGids: any[];
    knownFriendGidSyncCooldownSec: number;
    friendsListCacheTtlSec: number;
} {
    return {
        knownFriendGids: store.getKnownFriendGids ? store.getKnownFriendGids(accountId) : [],
        knownFriendGidSyncCooldownSec: store.getKnownFriendGidSyncCooldownSec
            ? store.getKnownFriendGidSyncCooldownSec(accountId)
            : 600,
        friendsListCacheTtlSec: store.getFriendsListCacheTtlSec
            ? store.getFriendsListCacheTtlSec(accountId)
            : 60,
    };
}

module.exports = {
    getClientIp,
    issueToken,
    createAuthRequired,
    createAdminRequired,
    revokeUserSessions,
    getRequestSession,
    canAccessAccount,
    getAllAccounts,
    getAccountList,
    getAccountIds,
    isSoftRuntimeError,
    isGatewayProtocolError,
    getProtocolErrorMessage,
    handleApiError,
    resolveAccId,
    getAccId,
    buildKnownFriendGidSettings,
};
