/**
 * Socket.IO setup and realtime emit functions.
 */
import type { AdminContext, Session } from './context';
export {};

const { Server } = require('socket.io');
const SocketIOServer = Server;

const {
    resolveAccId,
    getAccountIds,
} = require('./middleware');

function sessionReq(session: Session | null | undefined) {
    return { auth: session || undefined } as any;
}

function applySocketSubscription(ctx: AdminContext, socket: any, accountRef: string = ''): void {
    const session: Session | undefined = socket.data.session;
    const req = sessionReq(session);
    const incoming = String(accountRef || '').trim();
    const resolved = incoming && incoming !== 'all' ? resolveAccId(ctx, incoming, req) : '';
    const ownedIds: string[] = getAccountIds(ctx, req);

    for (const room of socket.rooms) {
        if (room.startsWith('account:')) socket.leave(room);
    }

    if (resolved) {
        socket.join(`account:${resolved}`);
        socket.data.accountId = resolved;
    } else if (session && session.role !== 'admin') {
        for (const id of ownedIds) socket.join(`account:${id}`);
        socket.data.accountId = '';
    } else {
        socket.join('account:all');
        socket.data.accountId = '';
    }
    socket.emit('subscribed', { accountId: socket.data.accountId || 'all' });

    try {
        const targetId = socket.data.accountId || '';
        if (targetId && ctx.provider && typeof ctx.provider.getStatus === 'function') {
            const currentStatus = ctx.provider.getStatus(targetId);
            socket.emit('status:update', { accountId: targetId, status: currentStatus });
        }
        if (ctx.provider && typeof ctx.provider.getLogs === 'function') {
            let currentLogs: any[] = [];
            if (targetId) {
                currentLogs = ctx.provider.getLogs(targetId, { limit: 100 });
            } else {
                const ids = ownedIds;
                for (const id of ids) {
                    const logs = ctx.provider.getLogs(id, { limit: 100 });
                    if (Array.isArray(logs)) currentLogs.push(...logs);
                }
                currentLogs.sort((a: any, b: any) => (b.time || 0) - (a.time || 0));
                currentLogs = currentLogs.slice(0, 100);
            }
            if (!Array.isArray(currentLogs)) currentLogs = [];

            socket.emit('logs:snapshot', {
                accountId: targetId || 'all',
                logs: currentLogs,
            });
        }
        if (ctx.provider && typeof ctx.provider.getAccountLogs === 'function') {
            let currentAccountLogs: any[] = ctx.provider.getAccountLogs(100);
            if (!Array.isArray(currentAccountLogs)) currentAccountLogs = [];
            if (session && session.role !== 'admin') {
                const owned = new Set(ownedIds);
                currentAccountLogs = currentAccountLogs.filter((entry: any) => owned.has(String(entry.accountId || '')));
            }

            socket.emit('account-logs:snapshot', {
                logs: currentAccountLogs,
            });
        }
    } catch {
        // ignore snapshot push errors
    }
}

function setupSocketIO(ctx: AdminContext): void {
    ctx.io = new SocketIOServer(ctx.server as any, {
        path: '/socket.io',
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
            allowedHeaders: ['x-admin-token', 'x-account-id'],
        },
    });

    ctx.io.use((socket: any, next: (err?: Error) => void) => {
        const authToken = socket.handshake.auth && socket.handshake.auth.token
            ? String(socket.handshake.auth.token)
            : '';
        const headerToken = socket.handshake.headers && socket.handshake.headers['x-admin-token']
            ? String(socket.handshake.headers['x-admin-token'])
            : '';
        const token = authToken || headerToken;
        const session = token ? ctx.tokens.get(token) : null;
        if (!token || !session) {
            return next(new Error('Unauthorized'));
        }
        socket.data.adminToken = token;
        socket.data.session = session;
        return next();
    });

    ctx.io.on('connection', (socket: any) => {
        const initialAccountRef = (socket.handshake.auth && socket.handshake.auth.accountId)
            || (socket.handshake.query && socket.handshake.query.accountId)
            || '';
        applySocketSubscription(ctx, socket, initialAccountRef);
        socket.emit('ready', { ok: true, ts: Date.now() });

        socket.on('subscribe', (payload: any) => {
            const body = (payload && typeof payload === 'object') ? payload : {};
            applySocketSubscription(ctx, socket, body.accountId || '');
        });
    });
}

function emitRealtimeStatus(ctx: AdminContext, accountId: string, status: any): void {
    if (!ctx.io) return;
    const id = String(accountId || '').trim();
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    ctx.io.to(`account:${id}`).emit('status:update', { accountId: id, status });
}

function emitRealtimeLog(ctx: AdminContext, entry: any): void {
    if (!ctx.io) return;
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();

    // 如果没有指定账号ID，不推送给任何人（防止数据泄露）
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    ctx.io.to(`account:${id}`).emit('log:new', payload);
}

function emitRealtimeAccountLog(ctx: AdminContext, entry: any): void {
    if (!ctx.io) return;
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();

    // 如果没有指定账号ID，不推送给任何人（防止数据泄露）
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    ctx.io.to(`account:${id}`).emit('account-log:new', payload);
}

module.exports = {
    setupSocketIO,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
};
