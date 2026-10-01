import type { Application, Request, Response } from 'express';
import type { AdminContext, Session } from './context';
export {};

const { version } = require('../../../package.json');
const { getRuntimeConfig } = require('../../config/config');
const { getSchedulerRegistrySnapshot } = require('../../services/scheduler');
const { createModuleLogger } = require('../../services/logger');
const adminStore = require('../../models/admin-store');
const userStore = require('../../models/user-store');
const cardKeyStore = require('../../models/card-key-store');

const {
    getClientIp,
    issueToken,
    createAuthRequired,
    createAdminRequired,
    revokeUserSessions,
    getRequestSession,
    getAccId,
    handleApiError,
} = require('./middleware');

const adminLogger = createModuleLogger('admin');

function loginStatus(errorType: string): number {
    if (errorType === 'rate_limit') return 429;
    if (errorType === 'locked') return 423;
    if (errorType === 'disabled' || errorType === 'expired') return 403;
    return 401;
}

function attachSession(ctx: AdminContext, session: Omit<Session, 'token'>): string {
    const token = issueToken();
    ctx.tokens.set(token, { ...session, token });
    return token;
}

function sessionPayload(session: Session | undefined, extra: Record<string, any> = {}) {
    if (!session) {
        return {
            token: '',
            role: 'user',
            user: { id: '', username: '' },
            quota: 0,
            usedQuota: 0,
            mustChangePassword: false,
            ...extra,
        };
    }
    const profile = session.role === 'admin'
        ? userStore.getAdminPublicInfo()
        : userStore.getPublicUser(session.userId);
    return {
        token: session.token,
        role: session.role,
        user: { id: session.userId, username: session.username },
        quota: profile?.quota ?? (session.role === 'admin' ? null : 0),
        usedQuota: profile?.usedQuota ?? 0,
        expiresAt: profile?.expiresAt ?? null,
        mustChangePassword: profile?.mustChangePassword === true,
        ...extra,
    };
}

function mountAuthRoutes(app: Application, ctx: AdminContext): void {
    const authRequired = createAuthRequired(ctx);
    const adminRequired = createAdminRequired();

    app.get('/api/card-keys/public', (_req: Request, res: Response) => {
        res.json({ ok: true, data: cardKeyStore.getPublicClaimStatus() });
    });

    app.post('/api/card-keys/claim', (_req: Request, res: Response) => {
        const claimed = cardKeyStore.claimCardKey();
        if (!claimed.ok) return res.status(claimed.status).json({ ok: false, error: claimed.error });
        return res.json({ ok: true, data: { code: claimed.code, days: claimed.days, description: claimed.description } });
    });

    app.post('/api/register', (req: Request, res: Response) => {
        const { username, password, cardKey } = req.body || {};
        const created = userStore.registerUser(String(username || ''), String(password || ''), String(cardKey || ''));
        if (!created.ok) {
            return res.status(created.status).json({ ok: false, error: created.error });
        }
        const token = attachSession(ctx, {
            userId: created.user.id,
            username: created.user.username,
            role: 'user',
        });
        adminLogger.info('用户注册成功', { username: created.user.username });
        return res.json({
            ok: true,
            data: {
                token,
                role: 'user',
                user: { id: created.user.id, username: created.user.username },
                quota: created.user.quota,
                usedQuota: created.user.usedQuota,
                expiresAt: created.user.expiresAt,
                mustChangePassword: false,
            },
        });
    });

    app.post('/api/login', (req: Request, res: Response) => {
        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(401).json({ ok: false, error: '请输入用户名和密码' });
        }

        const clientIp = getClientIp(req);
        const adminUsername = String(adminStore.getAdminInfo()?.username || 'admin');
        if (String(username) === adminUsername) {
            const adminResult = adminStore.validateAdmin(String(username), String(password), clientIp);
            if (!adminResult?.error) {
                const token = attachSession(ctx, {
                    userId: userStore.ADMIN_USER_ID,
                    username: adminResult.username,
                    role: 'admin',
                });
                adminLogger.info('超级管理员登录成功', { username: adminResult.username, ip: clientIp });
                return res.json({
                    ok: true,
                    data: sessionPayload(ctx.tokens.get(token), { mustChangePassword: adminResult.mustChangePassword === true }),
                });
            }
            const statusCode = loginStatus(adminResult.error);
            adminLogger.warn('登录失败', { username, error: adminResult.error, ip: clientIp });
            return res.status(statusCode).json({
                ok: false,
                error: adminResult.message,
                errorType: adminResult.error,
                remainingMs: adminResult.remainingMs,
            });
        }

        const userResult = userStore.validateUser(String(username), String(password), clientIp);
        if (userResult?.error) {
            const statusCode = loginStatus(userResult.error);
            adminLogger.warn('登录失败', { username, error: userResult.error, ip: clientIp });
            return res.status(statusCode).json({
                ok: false,
                error: userResult.message || userResult.error,
                errorType: userResult.error,
                remainingMs: userResult.remainingMs,
            });
        }

        const token = attachSession(ctx, {
            userId: userResult.id,
            username: userResult.username,
            role: 'user',
        });
        adminLogger.info('用户登录成功', { username: userResult.username, ip: clientIp });
        return res.json({
            ok: true,
            data: {
                token,
                role: 'user',
                user: { id: userResult.id, username: userResult.username },
                quota: userResult.quota,
                usedQuota: userResult.usedQuota,
                expiresAt: userResult.expiresAt,
                mustChangePassword: false,
            },
        });
    });

    app.post('/api/user/change-password', authRequired, (req: Request, res: Response) => {
        const session = getRequestSession(req);
        const { oldPassword, newPassword } = req.body || {};
        if (!oldPassword || !newPassword) {
            return res.status(400).json({ ok: false, error: '请提供原密码和新密码' });
        }
        const result = session?.role === 'admin'
            ? adminStore.changePassword(String(oldPassword), String(newPassword))
            : userStore.changeUserPassword(session?.userId, String(oldPassword), String(newPassword));
        if (result.ok && session) revokeUserSessions(ctx, session.userId);
        return res.json(result);
    });

    app.use('/api', (req: Request, res: Response, next: any) => {
        if (req.path === '/login' || req.path === '/register' || req.path === '/game-version' || req.path === '/card-keys/public' || req.path === '/card-keys/claim') return next();
        return authRequired(req, res, next);
    });

    app.get('/api/ping', (_req: Request, res: Response) => {
        res.json({ ok: true, data: { ok: true, uptime: process.uptime(), version } });
    });

    app.get('/api/game-version', (_req: Request, res: Response) => {
        res.json({ ok: true, clientVersion: getRuntimeConfig().clientVersion, botVersion: version });
    });

    app.get('/api/auth/validate', (_req: Request, res: Response) => {
        res.json({ ok: true, data: { valid: true } });
    });

    app.get('/api/scheduler', async (req: Request, res: Response) => {
        try {
            const id = getAccId(ctx, req);
            if (ctx.provider && typeof ctx.provider.getSchedulerStatus === 'function') {
                const data = await ctx.provider.getSchedulerStatus(id);
                return res.json({ ok: true, data });
            }
            return res.json({
                ok: true,
                data: {
                    runtime: getSchedulerRegistrySnapshot(),
                    worker: null,
                    workerError: 'DataProvider does not support scheduler status',
                },
            });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/logout', (req: Request, res: Response) => {
        const token = (req as any).adminToken;
        if (token) ctx.tokens.delete(token);
        if (ctx.io && token) {
            for (const socket of ctx.io.sockets.sockets.values()) {
                if (String((socket.data as any).adminToken || '') === String(token)) socket.disconnect(true);
            }
        }
        res.json({ ok: true });
    });

    app.get('/api/user/me', (req: Request, res: Response) => {
        const session = getRequestSession(req);
        const profile = session
            ? (session.role === 'admin' ? userStore.getAdminPublicInfo() : userStore.getPublicUser(session.userId))
            : null;
        if (!profile) return res.status(401).json({ ok: false, error: 'Unauthorized' });
        return res.json({ ok: true, data: profile });
    });

    app.get('/api/admin/users', adminRequired, (_req: Request, res: Response) => {
        res.json({ ok: true, data: userStore.listUsers() });
    });

    app.put('/api/admin/users/:id/quota', adminRequired, (req: Request, res: Response) => {
        const result = userStore.updateQuota(String(req.params.id || ''), Number((req.body || {}).quota));
        if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
        return res.json({ ok: true, data: result.user });
    });

    app.put('/api/admin/users/:id/enabled', adminRequired, (req: Request, res: Response) => {
        const enabled = (req.body || {}).enabled === true;
        const result = userStore.setUserEnabled(String(req.params.id || ''), enabled);
        if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
        if (!enabled) revokeUserSessions(ctx, result.user.id);
        return res.json({ ok: true, data: result.user });
    });

    app.get('/api/admin/card-keys', adminRequired, (_req: Request, res: Response) => {
        res.json({ ok: true, data: cardKeyStore.listCardKeys() });
    });

    app.post('/api/admin/card-keys', adminRequired, (req: Request, res: Response) => {
        const body = req.body || {};
        const result = cardKeyStore.createCardKeys({
            count: body.count,
            days: body.days,
            description: body.description,
        });
        if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
        return res.json({ ok: true, data: result.keys });
    });

    app.put('/api/admin/card-keys/claim-enabled', adminRequired, (req: Request, res: Response) => {
        const enabled = (req.body || {}).enabled === true;
        return res.json({ ok: true, data: cardKeyStore.setClaimEnabled(enabled) });
    });
}

module.exports = { mountAuthRoutes };
