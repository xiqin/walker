'use strict';

/**
 * Agent 与 Runtime 管理服务函数
 * 提供 driver 摘要、健康检查、自启、runtime 检测和核心健康检查功能
 */

/**
 * 列出所有已注册 agent driver 的状态摘要
 * stub driver（方法抛出未实现错误）标记为不可用，不误报为可执行
 * @param {Object} ctx - 上下文对象
 * @returns {Object[]} driver 摘要列表
 */
function listAgents(ctx) {
  const names = ctx.registry.list();
  return names.map((name) => {
    const driver = ctx.registry.get(name);
    const summary = {
      name,
      available: false,
      reason: '',
      config: {},
    };

    if (name === 'opencode') {
      summary.available = true;
      summary.config = {
        serverUrl: driver.serverUrl || '',
        autostart: driver.autostart !== undefined ? driver.autostart : true,
        opencodeCmd: driver.opencodeCmd || 'opencode',
      };
    } else {
      const isStub = detectStubDriver(driver);
      if (isStub) {
        summary.available = false;
        summary.reason = isStub.message;
      } else {
        summary.available = false;
        summary.reason = 'driver not available';
      }
    }

    return summary;
  });
}

/**
 * 检测 driver 是否为 stub driver（方法抛出未实现错误）
 * 同步检查方法源码中的错误信息，不实际调用异步方法
 * @param {Object} driver - driver 实例
 * @returns {{ isStub: boolean, message: string }|null}
 */
function detectStubDriver(driver) {
  const methods = ['ensureReady', 'createSession', 'prompt', 'stop', 'delete'];
  for (const method of methods) {
    const fn = driver[method];
    if (!fn) continue;
    try {
      const source = fn.toString();
      if (source.includes('not implemented') || source.includes('stub')) {
        return { isStub: true, message: 'stub driver not implemented' };
      }
    } catch (_e) {
      continue;
    }
  }
  return null;
}

/**
 * 对指定 agent driver 执行健康检查
 * @param {Object} ctx - 上下文对象
 * @param {string} agentName - driver 名称
 * @returns {Promise<Object>} 检查结果，含 healthy、error 和 config 字段
 */
async function checkAgent(ctx, agentName) {
  const driver = ctx.registry.get(agentName);
  if (!driver) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'agent driver not found: ' + agentName } };
  }

  try {
    const ready = await driver.ensureReady();
    return {
      ok: true,
      healthy: ready,
      agent: agentName,
      config: agentName === 'opencode' ? {
        serverUrl: driver.serverUrl || '',
        autostart: driver.autostart !== undefined ? driver.autostart : true,
      } : {},
    };
  } catch (err) {
    return {
      ok: true,
      healthy: false,
      agent: agentName,
      error: err.message,
      config: agentName === 'opencode' ? {
        serverUrl: driver.serverUrl || '',
        autostart: driver.autostart !== undefined ? driver.autostart : true,
      } : {},
    };
  }
}

/**
 * 确保 OpenCode 服务就绪可用，必要时调用 ensureReady 自启
 * @param {Object} ctx - 上下文对象
 * @returns {Promise<Object>} 结果对象，含 ready 状态和可能的 error
 */
async function ensureReadyAgent(ctx) {
  const driver = ctx.registry.get('opencode');
  if (!driver) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'opencode driver not registered' } };
  }

  try {
    const ready = await driver.ensureReady();
    return { ok: true, ready, agent: 'opencode' };
  } catch (err) {
    return { ok: true, ready: false, error: err.message, agent: 'opencode' };
  }
}

/**
 * 检测 runtime 配置和运行环境摘要
 * @param {Object} ctx - 上下文对象
 * @param {Object} [opts] - 检测选项
 * @param {Function} [opts.detectWslIp] - WSL IP 探测函数
 * @param {Function} [opts.checkCwd] - cwd 存在性检查函数
 * @returns {Object} runtime 检测结果，含 Windows/WSL 配置和探测摘要
 */
function detectRuntime(ctx, opts) {
  const options = opts || {};
  const envConfig = ctx.envConfig || {};
  const runtimeConfig = {
    windows: {
      type: 'windows',
      cwd: envConfig.walkerDefaultCwd || '',
      cwdExists: false,
    },
    wsl: null,
  };

  const cwdPath = envConfig.walkerDefaultCwd || process.cwd();
  if (options.checkCwd) {
    runtimeConfig.windows.cwdExists = options.checkCwd(cwdPath);
  }

  const distro = envConfig.walkerWslDistro || 'Ubuntu-24.04';
  runtimeConfig.wsl = {
    type: 'wsl',
    distro,
    cwd: envConfig.walkerDefaultCwd || '',
    cwdExists: runtimeConfig.windows.cwdExists,
    ipDetected: false,
    ip: '',
    ipError: '',
  };

  if (options.detectWslIp) {
    try {
      const ip = options.detectWslIp(distro);
      runtimeConfig.wsl.ipDetected = true;
      runtimeConfig.wsl.ip = ip;
    } catch (err) {
      runtimeConfig.wsl.ipError = err.message;
    }
  }

  return runtimeConfig;
}

/**
 * 核心健康检查：覆盖孤立 route、OpenCode 可用性和 runtime
 * @param {Object} ctx - 上下文对象
 * @param {Object} [opts] - 检测选项
 * @returns {Promise<Object>} 健康检查结果列表，每条含 name、status、detail
 */
async function detectHealth(ctx, opts) {
  const options = opts || {};
  const checks = [];

  const dangling = ctx.routeAdmin ? ctx.routeAdmin.detectDangling(ctx) : [];
  checks.push({
    name: 'dangling_routes',
    status: dangling.length > 0 ? 'warn' : 'pass',
    detail: dangling.length + ' dangling route(s)',
    items: dangling,
  });

  if (ctx.registry) {
    try {
      const ready = await checkAgent(ctx, 'opencode');
      checks.push({
        name: 'opencode',
        status: ready.healthy ? 'pass' : 'fail',
        detail: ready.healthy ? 'opencode server is ready' : (ready.error || 'opencode not available'),
      });
    } catch (err) {
      checks.push({
        name: 'opencode',
        status: 'fail',
        detail: err.message,
      });
    }
  }

  const runtimeInfo = detectRuntime(ctx, options);
  checks.push({
    name: 'runtime',
    status: 'pass',
    detail: 'windows cwd exists: ' + runtimeInfo.windows.cwdExists,
    runtime: runtimeInfo,
  });

  return checks;
}

module.exports = {
  listAgents,
  checkAgent,
  ensureReadyAgent,
  detectRuntime,
  detectHealth,
};
