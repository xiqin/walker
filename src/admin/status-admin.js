'use strict';

const STATUS_NAMES = [
  'walker', 'feishu', 'opencode', 'tuiBridge', 'runtimes', 'watchers', 'health', 'admin',
];
const VALID_STATUSES = new Set(['healthy', 'warning', 'failed', 'unknown']);

/**
 * 创建实时状态聚合器。
 * @param {Object} ctx - 应用上下文，可通过 statusChecks 注入各项检测函数。
 * @param {Object} [options] - 聚合选项。
 * @param {number} [options.timeoutMs] - 单项检测超时毫秒数。
 * @param {Function} [options.now] - 当前时间函数。
 * @returns {{getStatus: Function}} 状态聚合器。
 */
function createStatusAdmin(ctx, options) {
  const context = ctx || {};
  const opts = options || {};
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : 2000;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  /**
   * 并行执行全部检测并隔离单项失败。
   * @returns {Promise<Object>} 按固定名称组织的状态快照。
   */
  async function getStatus() {
    const entries = await Promise.all(STATUS_NAMES.map(async (name) => {
      const checkedAt = now();
      const check = resolveCheck(context, name);
      if (!check) return [name, { status: 'unknown', checkedAt, reason: 'status check unavailable' }];
      try {
        const value = await withTimeout(Promise.resolve().then(check), timeoutMs, name);
        return [name, normalizeStatus(value, checkedAt)];
      } catch (err) {
        return [name, {
          status: 'failed',
          checkedAt,
          reason: err && err.message ? err.message : String(err),
        }];
      }
    }));
    return Object.fromEntries(entries);
  }

  return { getStatus };
}

/**
 * 查找指定状态项的检测函数。
 * @param {Object} ctx - 应用上下文。
 * @param {string} name - 状态项名称。
 * @returns {Function|null} 检测函数。
 */
function resolveCheck(ctx, name) {
  if (ctx.statusChecks && typeof ctx.statusChecks[name] === 'function') {
    return ctx.statusChecks[name];
  }
  const defaults = {
    walker: () => readLifecycle(ctx.lifecycle, 'Walker'),
    feishu: () => readFeishuStatus(ctx.feishu),
    opencode: () => {
      const driver = ctx.registry && ctx.registry.get && ctx.registry.get('opencode');
      return readOpenCodeStatus(driver);
    },
    tuiBridge: () => readTuiBridgeStatus(ctx.tuiBridge),
    runtimes: () => {
      if (!ctx.tuiBridge || typeof ctx.tuiBridge.getRuntimeSnapshots !== 'function') return { status: 'unknown', reason: 'runtime snapshots unavailable' };
      return summarizeSnapshots(ctx.tuiBridge.getRuntimeSnapshots(), 'runtime', (item) => item && item.health);
    },
    watchers: () => readWatchersStatus(ctx.dispatcher),
    health: () => {
      if (!ctx.healthPoller || typeof ctx.healthPoller.getHealthSnapshots !== 'function') return { status: 'unknown', reason: 'health snapshots unavailable' };
      return summarizeSnapshots(ctx.healthPoller.getHealthSnapshots(), 'health');
    },
    admin: () => readAdminStatus(ctx.adminServer),
  };
  return defaults[name] || null;
}

function readLifecycle(lifecycle, label) {
  if (!lifecycle || typeof lifecycle.started !== 'boolean') {
    return { status: 'unknown', reason: label + ' lifecycle unavailable' };
  }
  return lifecycle.started ? { status: 'healthy' }
    : { status: 'failed', reason: label + ' not started' };
}

function readFeishuStatus(platform) {
  if (!platform || !platform.wsClient || typeof platform.wsClient.getConnectionStatus !== 'function') {
    return { status: 'unknown', reason: 'Feishu websocket status unavailable' };
  }
  try {
    return normalizeFeishuConnection(platform.wsClient.getConnectionStatus());
  } catch (err) {
    return { status: 'unknown', reason: 'Feishu websocket status unavailable: ' + (err && err.message ? err.message : String(err)) };
  }
}

function normalizeFeishuConnection(value) {
  if (!value || typeof value !== 'object' || typeof value.state !== 'string') {
    return { status: 'unknown', reason: 'Feishu websocket status invalid' };
  }
  if (value.state === 'connected') return { ...value, status: 'healthy' };
  if (value.state === 'connecting' || value.state === 'reconnecting') {
    return { ...value, status: 'warning', reason: 'Feishu websocket ' + value.state };
  }
  if (value.state === 'failed') return { ...value, status: 'failed', reason: 'Feishu websocket failed' };
  if (value.state === 'idle') return { ...value, status: 'failed', reason: 'Feishu websocket idle' };
  return { ...value, status: 'unknown', reason: 'Feishu websocket state unsupported: ' + value.state };
}

function readOpenCodeStatus(driver) {
  if (!driver || typeof driver._checkHealth !== 'function') {
    return { status: 'unknown', reason: 'OpenCode health probe unavailable' };
  }
  return Promise.resolve(driver._checkHealth()).then((healthy) => healthy
    ? { status: 'healthy' }
    : { status: 'failed', reason: 'OpenCode server unavailable' });
}

function readTuiBridgeStatus(bridge) {
  if (!bridge || !(bridge.runtimes instanceof Map)) {
    return { status: 'unknown', reason: 'TUI Bridge runtime registry unavailable' };
  }
  return { status: 'healthy', runtimeCount: bridge.runtimes.size };
}

function readWatchersStatus(dispatcher) {
  if (!dispatcher || !(dispatcher.sessionWatchStops instanceof Map)) {
    return { status: 'unknown', reason: 'watcher registry unavailable' };
  }
  return { status: 'healthy', watcherCount: dispatcher.sessionWatchStops.size };
}

/**
 * 汇总一组实时快照，按失败、警告、未知、健康的优先级返回结果。
 * @param {Object[]} snapshots - 实时快照列表。
 * @param {string} label - 快照类型名称。
 * @param {Function} [selectStatus] - 从快照中选择状态对象的函数。
 * @returns {Object} 汇总状态。
 */
function summarizeSnapshots(snapshots, label, selectStatus) {
  if (!Array.isArray(snapshots)) return { status: 'unknown', reason: label + ' snapshots unavailable' };
  if (snapshots.length === 0) return { status: 'healthy', count: 0 };
  const statuses = snapshots.map((item) => {
    const value = selectStatus ? selectStatus(item) : item;
    return value && typeof value === 'object' ? value : { status: 'unknown' };
  });
  for (const status of ['failed', 'warning', 'unknown']) {
    const match = statuses.find((item) => item.status === status);
    if (match) return { status, reason: match.reason || label + ' reported ' + status };
  }
  return { status: statuses.every((item) => item.status === 'healthy') ? 'healthy' : 'unknown',
    ...(statuses.every((item) => item.status === 'healthy') ? {} : { reason: label + ' status unavailable' }) };
}

/**
 * 读取 AdminServer 生命周期状态。
 * @param {Object} adminServer - AdminServer 实例。
 * @returns {Object|Promise<Object>} Admin 状态。
 */
function readAdminStatus(adminServer) {
  if (!adminServer || typeof adminServer.getStatus !== 'function') {
    return { status: 'unknown', reason: 'Admin lifecycle status unavailable' };
  }
  return Promise.resolve(adminServer.getStatus()).then((value) => {
    if (value && VALID_STATUSES.has(value.status)) return { ...value };
    if (!value || typeof value.started !== 'boolean') return { status: 'unknown', reason: 'Admin lifecycle status unavailable' };
    if (value.disabled) return { ...value, status: 'warning', reason: value.reason || 'Admin server disabled' };
    return value.started ? { ...value, status: 'healthy' }
      : { ...value, status: 'failed', reason: value.reason || 'Admin server not started' };
  });
}

/**
 * 规范化检测返回值并补充检查时间。
 * @param {Object|string|boolean} value - 原始检测结果。
 * @param {number} checkedAt - 检查时间。
 * @returns {Object} 统一状态对象。
 */
function normalizeStatus(value, checkedAt) {
  let result;
  if (typeof value === 'string') result = { status: value };
  else if (typeof value === 'boolean') result = { status: value ? 'healthy' : 'failed' };
  else result = value && typeof value === 'object' ? { ...value } : { status: 'unknown' };
  if (!VALID_STATUSES.has(result.status)) result.status = 'unknown';
  result.checkedAt = checkedAt;
  return result;
}

/**
 * 为 Promise 设置有界超时。
 * @param {Promise} promise - 待执行 Promise。
 * @param {number} timeoutMs - 超时毫秒数。
 * @param {string} name - 检测名称。
 * @returns {Promise<*>} 检测结果。
 */
function withTimeout(promise, timeoutMs, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(name + ' status check timed out after ' + timeoutMs + 'ms')), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

module.exports = { createStatusAdmin };
