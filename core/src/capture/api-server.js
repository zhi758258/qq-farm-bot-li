/**
 * 抓包服务 REST API（Express 包装 + 进程内共享 handler）
 *
 * 同一套 handler 支持两种调用方式：
 * - 独立模式：Express 监听独立端口（如 8450），供外部 HTTP 调用；
 * - 嵌入模式：bot 进程内直接调用 `handleApiRequest`（不走网络/端口）。
 */

const express = require('express');
const { resolveAdvertiseAddresses } = require('./ip-utils');

/** @returns {any} */
function createCaptureApi({ config, ca, sessionStore, proxyManager, log = () => {} } = {}) {
  const startedAt = Date.now();

  function extractSessionIdFromPath(method, path) {
    const segments = String(path || '').split('/').filter(Boolean);
    if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2]) {
      return decodeURIComponent(segments[2]);
    }
    return '';
  }

  /**
   * 进程内 API 调用（与 HTTP JSON 响应同构）
   */
  async function handleApiRequest(method, path, body = {}, context = {}) {
    const sessionId = String((context && context.sessionId) || body.sessionId || '')
      || extractSessionIdFromPath(method, path);

    const key = `${String(method || 'GET').toUpperCase()} ${String(path || '').replace(/\/+$/, '')}`;

    try {
      if (key === 'GET /api/health') {
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              uptime: Math.floor((Date.now() - startedAt) / 1000),
              sessions: sessionStore.listSessions().length,
              portPool: [config.proxyPortFrom],
            },
          },
        };
      }

      if (key === 'POST /api/sessions') {
        if (!sessionId) {
          return { status: 400, body: { ok: false, error: '缺少会话 ID' } };
        }
        const platform = String(body.platform || 'qq');
        const session = sessionStore.createSession(sessionId, platform);
        log('info', `创建抓包会话: ${sessionId}`, { sessionId, platform });
        return { status: 200, body: { ok: true, data: sessionStore.buildSnapshot(session) } };
      }

      if (key === 'POST /api/capture/start') {
        const session = sessionStore.getSession(sessionId);
        if (!session) return { status: 404, body: { ok: false, error: '会话不存在' } };

        const bypassHosts = Array.isArray(body.bypassHosts) ? body.bypassHosts : [];
        const advertise = resolveAdvertiseAddresses(config);
        const requestedHost = String(body.advertiseHost || '').trim().toLowerCase();
        if (requestedHost && requestedHost.length <= 253 && !/[\s/?#@]/.test(requestedHost)) {
          const existing = advertise.addresses.find(item => item.address === requestedHost);
          advertise.host = requestedHost;
          advertise.addresses = [
            existing || { address: requestedHost, kind: 'panel' },
            ...advertise.addresses.filter(item => item.address !== requestedHost),
          ];
        }

        const started = await proxyManager.startForSession(session, { bypassHosts });
        sessionStore.setProxyInfo(session, {
          port: started.port,
          startedAt: started.startedAt,
          host: advertise.host,
          addresses: advertise.addresses,
          certUrl: '/cert/mitmproxy-ca-cert.cer',
          autoStopSec: config.autoStopSec,
          bypassHosts: started.bypassHosts,
          running: true,
          status: 'running',
        });
        return { status: 200, body: { ok: true, data: sessionStore.buildSnapshot(session) } };
      }

      if (key === 'POST /api/capture/stop') {
        const session = sessionStore.getSession(sessionId);
        if (session) await proxyManager.stopForSession(session);
        return { status: 200, body: { ok: true, data: {} } };
      }

      if (key === 'GET /api/sessions') {
        return { status: 200, body: { ok: true, data: { sessions: sessionStore.listSessions() } } };
      }

      if (key.startsWith('GET /api/sessions/') && key.endsWith('/state')) {
        const session = sessionStore.getSession(sessionId);
        if (!session) return { status: 404, body: { ok: false, error: '会话不存在' } };
        return { status: 200, body: { ok: true, data: sessionStore.buildSnapshot(session) } };
      }

      if (key.startsWith('DELETE /api/sessions/')) {
        const session = sessionStore.getSession(sessionId);
        if (session) {
          await proxyManager.stopForSession(session);
          sessionStore.deleteSession(session.id);
        }
        return { status: 200, body: { ok: true, data: {} } };
      }

      if (key === 'GET /api/info') {
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              name: 'qq-farm-capture',
              embedded: true,
              addresses: resolveAdvertiseAddresses(config),
              config: {
                proxyPortFrom: config.proxyPortFrom,
                proxyPortTo: config.proxyPortTo,
                autoStopSec: config.autoStopSec,
              },
            },
          },
        };
      }

      return { status: 404, body: { ok: false, error: '未找到接口' } };
    } catch (error) {
      return {
        status: 502,
        body: { ok: false, error: String(error && error.message || error || '内部错误') },
      };
    }
  }

  function getCaCertDer() {
    return ca.getCaCertDer();
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  function checkAuth(req, res, next) {
    if (!config.apiToken) {
      next();
      return;
    }
    const expected = `Bearer ${config.apiToken}`;
    if (String(req.headers.authorization || '') !== expected) {
      res.status(401).json({ ok: false, error: '未授权' });
      return;
    }
    next();
  }

  const wrap = handler => async (req, res) => {
    const result = await handler(req);
    if (result.buffer) {
      res.setHeader('Content-Type', 'application/x-x509-ca-cert');
      res.setHeader('Content-Disposition', 'inline; filename="mitmproxy-ca-cert.cer"');
      res.setHeader('Cache-Control', 'no-store');
      res.send(result.buffer);
      return;
    }
    res.status(result.status || 500).json(result.body || { ok: false, error: '内部错误' });
  };

  const getSessionIdFromReq = req => String(req.headers['x-capture-session-id'] || '').trim()
    || String((req.body && req.body.sessionId) || '').trim()
    || String(req.params.id || '').trim();

  app.get('/', (req, res) => {
    res.json({ ok: true, name: 'qq-farm-capture', version: '1.0.0' });
  });
  app.use('/api', checkAuth);
  app.get('/api/health', wrap(req => handleApiRequest('GET', '/api/health', {}, { sessionId: getSessionIdFromReq(req) })));
  app.post('/api/sessions', wrap(req => handleApiRequest('POST', '/api/sessions', req.body || {}, { sessionId: getSessionIdFromReq(req) })));
  app.post('/api/capture/start', wrap(req => handleApiRequest('POST', '/api/capture/start', req.body || {}, { sessionId: getSessionIdFromReq(req) })));
  app.post('/api/capture/stop', wrap(req => handleApiRequest('POST', '/api/capture/stop', req.body || {}, { sessionId: getSessionIdFromReq(req) })));
  app.get('/api/sessions/:id/state', wrap(req => handleApiRequest('GET', `/api/sessions/${req.params.id}/state`, {}, { sessionId: getSessionIdFromReq(req) })));
  app.delete('/api/sessions/:id', wrap(req => handleApiRequest('DELETE', `/api/sessions/${req.params.id}`, {}, { sessionId: getSessionIdFromReq(req) })));
  app.get('/api/info', wrap(req => handleApiRequest('GET', '/api/info', {}, { sessionId: getSessionIdFromReq(req) })));
  app.get('/cert/mitmproxy-ca-cert.cer', wrap(() => ({ status: 200, buffer: getCaCertDer() })));

  function start() {
    return new Promise((resolve, reject) => {
      const server = app.listen(config.apiPort, config.apiHost, () => {
        log('info', `抓包服务 API 已启动: http://${config.apiHost}:${config.apiPort}`);
        resolve(server);
      });
      server.on('error', reject);
    });
  }

  return { app, start, handleApiRequest, getCaCertDer };
}

module.exports = { createCaptureApi };
