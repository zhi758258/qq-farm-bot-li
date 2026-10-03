/**
 * 抓包服务入口
 *
 * 提供两种运行方式：
 * - 嵌入模式（默认）：createCaptureCore() 在 bot 进程内运行，REST API 由
 *   capture-routes 进程内直接调用（handleApiRequest），不占用独立端口；
 * - 独立模式：startCaptureServer() 额外启动 Express 监听独立端口（如 8450），
 *   供 `pnpm capture:start` / `client.js --capture` 使用。
 *
 * 两种模式共享同一套核心：CA → 会话存储 → MITM 代理 → 好友提取器。
 * MITM 端口仅在会话 start 时监听，stop / 自动超时 / 账号完成后关闭。
 */

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const {
  getCaCertDer,
  getSecureContextForHost,
  loadOrCreateRootCa,
} = require('./ca');
const { createSessionStore } = require('./session-store');
const { createMitmProxyManager } = require('./mitm-proxy');
const { createCaptureApi } = require('./api-server');
const { createFriendExtractor } = require('./friend-extractor');

/** 组合并导出 CA 模块接口（供代理管理器使用） */
function buildCaModule(ca) {
  return {
    getSecureContextForHost: host => getSecureContextForHost(ca, host),
    getCaCertDer: () => getCaCertDer(ca),
  };
}

/**
 * 创建抓包服务核心（不监听任何端口，可嵌入 bot 进程）。
 */
/** @returns {any} */
function createCaptureCore(options = {}) {
  const { config, dataDir } = loadConfig(options);
  const log = options.log || createLogger(config.logLevel);

  const rootCa = loadOrCreateRootCa(dataDir);
  const ca = buildCaModule(rootCa);
  const sessionStore = createSessionStore({ config });

  let proxyManager = null;
  let cleanupTimer = null;
  let stopRequested = false;

  const ready = (async () => {
    const friendExtractor = await createFriendExtractor();
    proxyManager = createMitmProxyManager({ config, ca, friendExtractor, sessionStore, log });
    log('info', '好友 GID 提取器就绪（proto 加载完成）');
  })();
  ready.catch((error) => {
    log('error', `抓包服务初始化失败: ${error.message}`);
  });

  const api = createCaptureApi({
    config,
    ca,
    sessionStore,
    proxyManager: {
      startForSession: (...args) => ready.then(() => proxyManager.startForSession(...args)),
      stopForSession: (...args) => ready.then(() => proxyManager.stopForSession(...args)),
    },
    log,
  });

  cleanupTimer = setInterval(() => {
    sessionStore.cleanupExpired();
  }, 60_000);
  if (cleanupTimer.unref) cleanupTimer.unref();

  async function stop() {
    if (stopRequested) return;
    stopRequested = true;
    if (cleanupTimer) clearInterval(cleanupTimer);
    await ready;
    for (const id of sessionStore.listSessions()) {
      const session = sessionStore.getSession(id);
      if (session) await proxyManager.stopForSession(session);
    }
    log('info', '抓包服务核心已停止');
  }

  return {
    config,
    dataDir,
    log,
    ready,
    ca,
    sessionStore,
    api,
    handleApiRequest: async (method, path, body, context) => {
      await ready;
      return api.handleApiRequest(method, path, body, context);
    },
    getCaCertDer: () => api.getCaCertDer(),
    stop,
  };
}

/**
 * 启动独立抓包服务（监听 API 端口）
 */
/** @returns {Promise<any>} */
async function startCaptureServer(options = {}) {
  const core = createCaptureCore(options);
  await core.ready;
  await core.api.start();

  return {
    config: core.config,
    dataDir: core.dataDir,
    stop: core.stop,
    apiServer: core.api,
    sessionStore: core.sessionStore,
    proxyManager: core.proxyManager,
    ca: core.ca,
    log: core.log,
  };
}

module.exports = {
  buildCaModule,
  createCaptureCore,
  startCaptureServer,
};
