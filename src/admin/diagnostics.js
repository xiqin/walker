'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');

const CHECK_GROUPS = Object.freeze({
  feishu_credentials: 'connections',
  data_directory: 'storage',
  json_files: 'storage',
  opencode: 'connections',
  runtime: 'runtime',
  log_files: 'observability',
  dangling_routes: 'sessions-routes',
  node_version: 'environment',
  memory_usage: 'resources',
  disk_space: 'resources',
  port_status: 'network',
});

const LOG_FILE_OUT = 'walker-out.log';
const LOG_FILE_ERR = 'walker-err.log';

const MAX_HEALTH_HISTORY = 100;
const healthHistory = [];

/**
 * 收集上下文中的敏感值，用于诊断错误脱敏。
 * @param {Object} ctx - 应用上下文。
 * @returns {string[]} 非空敏感值列表。
 */
function collectSecrets(ctx) {
  const envConfig = ctx.envConfig || {};
  const values = [
    envConfig.feishuAppSecret,
    envConfig.admin && envConfig.admin.token,
    ctx.config && ctx.config.token,
  ];
  return values.filter((value) => typeof value === 'string' && value);
}

/**
 * 从诊断文本中移除已知敏感值。
 * @param {*} value - 原始字段值。
 * @param {string[]} secrets - 敏感值列表。
 * @returns {*} 脱敏后的字段值。
 */
function redactValue(value, secrets) {
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]));
  }
  return value;
}

/**
 * 将旧检查结果规范为前端和导出共用 DTO。
 * @param {Object} result - 原始检查结果。
 * @param {Object} definition - 检查定义。
 * @param {string[]} secrets - 敏感值列表。
 * @returns {Object} 结构化检查项。
 */
function normalizeCheck(result, definition, secrets) {
  const item = redactValue(result || {}, secrets);
  const name = item.name || definition.name;
  const detail = redactValue(item.detail || '', secrets);
  return {
    ...item,
    name,
    group: item.group || definition.group || CHECK_GROUPS[name] || 'walker',
    status: item.status || 'fail',
    checkedAt: item.checkedAt || new Date().toISOString(),
    detail,
    reason: redactValue(item.reason || detail || null, secrets),
    suggestion: redactValue(item.suggestion || null, secrets),
    action: item.action || null,
  };
}

/**
 * 执行单项诊断并把异常转换为失败项。
 * @param {Object} definition - 检查定义。
 * @param {Object} ctx - 应用上下文。
 * @param {string[]} secrets - 敏感值列表。
 * @returns {Promise<Object>} 结构化检查项。
 */
async function executeCheck(definition, ctx, secrets) {
  try {
    const result = await definition.run(ctx);
    return normalizeCheck(result, definition, secrets);
  } catch (err) {
    return normalizeCheck({
      name: definition.name,
      status: 'fail',
      detail: err.message,
      reason: err.message,
    }, definition, secrets);
  }
}

/**
 * 一键健康检查：返回 pass/warn/fail 项目数组
 * 单项检查失败不导致整体抛错，保证页面所需状态始终可获取
 * @param {Object} ctx - 应用上下文
 * @param {string} ctx.dataDir - 数据目录绝对路径
 * @param {Object} [ctx.envConfig] - 环境配置
 * @param {Object} [ctx.registry] - Driver 注册表
 * @param {Object} [ctx.sessionService] - Session 服务
 * @param {Object} [ctx.routeAdmin] - Route 管理模块
 * @returns {Promise<Object[]>} 检查结果数组，每项含 name、status、detail
 */
async function runHealthCheck(ctx) {
  const context = ctx || {};
  const definitions = Array.isArray(context.diagnosticChecks) ? context.diagnosticChecks : [
    { name: 'feishu_credentials', group: CHECK_GROUPS.feishu_credentials, run: checkFeishuCredentials },
    { name: 'data_directory', group: CHECK_GROUPS.data_directory, run: checkDataDirectory },
    { name: 'json_files', group: CHECK_GROUPS.json_files, run: checkJsonFiles },
    { name: 'opencode', group: CHECK_GROUPS.opencode, run: checkOpenCode },
    { name: 'runtime', group: CHECK_GROUPS.runtime, run: checkRuntime },
    { name: 'log_files', group: CHECK_GROUPS.log_files, run: checkLogFiles },
    { name: 'dangling_routes', group: CHECK_GROUPS.dangling_routes, run: checkDanglingRoutes },
    { name: 'node_version', group: CHECK_GROUPS.node_version, run: checkNodeVersion },
    { name: 'memory_usage', group: CHECK_GROUPS.memory_usage, run: checkMemoryUsage },
    { name: 'disk_space', group: CHECK_GROUPS.disk_space, run: checkDiskSpace },
    { name: 'port_status', group: CHECK_GROUPS.port_status, run: checkPortStatus },
  ];
  const secrets = collectSecrets(context);
  const checks = await Promise.all(definitions.map((definition) => executeCheck(definition, context, secrets)));

  const allPass = checks.every((c) => c.status === 'pass');
  const historyEntry = {
    id: `health_${Date.now()}`,
    timestamp: new Date().toISOString(),
    overall: allPass ? 'pass' : 'degraded',
    checks: checks.map((c) => ({ name: c.name, status: c.status })),
  };

  healthHistory.push(historyEntry);
  if (healthHistory.length > MAX_HEALTH_HISTORY) {
    healthHistory.splice(0, healthHistory.length - MAX_HEALTH_HISTORY);
  }

  return checks;
}

/**
 * 获取健康检查历史记录
 * @param {number} [limit] - 返回历史记录数量，默认 20
 * @returns {Object[]} 历史记录列表
 */
function getHealthHistory(limit) {
  const maxItems = Math.min(Math.max(limit || 20, 1), MAX_HEALTH_HISTORY);
  return healthHistory.slice(-maxItems).reverse();
}

/**
 * 清空健康检查历史记录
 */
function clearHealthHistory() {
  healthHistory.length = 0;
  return { ok: true };
}

/**
 * 检查飞书凭据是否完整配置
 * @param {Object} ctx - 应用上下文
 * @returns {Object} 检查结果
 */
function checkFeishuCredentials(ctx) {
  const envConfig = ctx.envConfig || {};
  const appId = envConfig.feishuAppId || '';
  const appSecret = envConfig.feishuAppSecret || '';
  const source = envConfig.feishuConfigSource || 'missing';

  if (appId && appSecret) {
    return {
      name: 'feishu_credentials',
      status: 'pass',
      detail: `飞书凭据已配置（来源：${source}）`,
    };
  }

  if (appId && !appSecret) {
    return {
      name: 'feishu_credentials',
      status: 'warn',
      detail: '飞书 APP_ID 已配置但 APP_SECRET 缺失',
    };
  }

  return {
    name: 'feishu_credentials',
    status: source === 'missing' ? 'fail' : 'warn',
    detail: '飞书凭据未配置',
  };
}

/**
 * 检查数据目录是否存在且可写
 * @param {Object} ctx - 应用上下文
 * @returns {Object} 检查结果
 */
function checkDataDirectory(ctx) {
  const dataDir = ctx.dataDir || '';

  if (!dataDir) {
    return {
      name: 'data_directory',
      status: 'warn',
      detail: '未配置数据目录',
    };
  }

  try {
    if (!fs.existsSync(dataDir)) {
      return {
        name: 'data_directory',
        status: 'fail',
        detail: `数据目录不存在：${dataDir}`,
      };
    }

    try {
      fs.accessSync(dataDir, fs.constants.W_OK);
    } catch (_e) {
      return {
        name: 'data_directory',
        status: 'warn',
        detail: `数据目录存在但不可写：${dataDir}`,
      };
    }

    return {
      name: 'data_directory',
      status: 'pass',
      detail: `数据目录存在且可写：${dataDir}`,
    };
  } catch (err) {
    return {
      name: 'data_directory',
      status: 'fail',
      detail: `检查数据目录失败：${err.message}`,
    };
  }
}

/**
 * 检查关键 JSON 文件完整性（sessions 和 routes）
 * @param {Object} ctx - 应用上下文
 * @returns {Object} 检查结果
 */
function checkJsonFiles(ctx) {
  const dataDir = ctx.dataDir || '';
  const issues = [];

  const filesToCheck = [
    { name: 'state.json', label: '状态数据' },
  ];

  for (const file of filesToCheck) {
    const filePath = path.join(dataDir, file.name);
    try {
      if (!fs.existsSync(filePath)) {
        issues.push(`${file.label}文件不存在`);
        continue;
      }
      const raw = fs.readFileSync(filePath, 'utf8');
      try {
        JSON.parse(raw);
      } catch (_e) {
        issues.push(`${file.label}文件 JSON 格式损坏`);
      }
    } catch (err) {
      issues.push(`${file.label}文件读取失败：${err.message}`);
    }
  }

  if (issues.length === 0) {
    return {
      name: 'json_files',
      status: 'pass',
      detail: '所有 JSON 文件完整',
    };
  }

  return {
    name: 'json_files',
    status: issues.some((i) => i.includes('损坏') || i.includes('失败')) ? 'fail' : 'warn',
    detail: issues.join('; '),
    issues,
  };
}

/**
 * 检查 OpenCode 服务是否可用
 * @param {Object} ctx - 应用上下文
 * @returns {Promise<Object>} 检查结果
 */
async function checkOpenCode(ctx) {
  const registry = ctx.registry;
  if (!registry) {
    return {
      name: 'opencode',
      status: 'warn',
      detail: 'Driver 注册表未提供',
    };
  }

  const driver = registry.get('opencode');
  if (!driver) {
    return {
      name: 'opencode',
      status: 'fail',
      detail: 'opencode driver 未注册',
    };
  }

  try {
    const ready = typeof driver._checkHealth === 'function'
      ? await driver._checkHealth()
      : await driver.ensureReady();
    if (ready) {
      return {
        name: 'opencode',
        status: 'pass',
        detail: 'opencode 服务可用',
      };
    }
    return {
      name: 'opencode',
      status: 'fail',
      detail: 'opencode 服务未就绪',
    };
  } catch (err) {
    return {
      name: 'opencode',
      status: 'fail',
      detail: `opencode 检查失败：${err.message}`,
    };
  }
}

/**
 * 检查 runtime 配置和运行环境状态
 * @param {Object} ctx - 应用上下文
 * @returns {Object} 检查结果
 */
function checkRuntime(ctx) {
  try {
    const envConfig = ctx.envConfig || {};
    const runtime = envConfig.walkerDefaultRuntime || 'windows';
    const cwd = envConfig.walkerDefaultCwd || '';

    if (!cwd) {
      return {
        name: 'runtime',
        status: 'warn',
        detail: `运行时 ${runtime} 配置正常但未设置默认工作目录`,
      };
    }

    try {
      if (fs.existsSync(cwd)) {
        return {
          name: 'runtime',
          status: 'pass',
          detail: `运行时 ${runtime}，工作目录存在：${cwd}`,
        };
      }
      return {
        name: 'runtime',
        status: 'warn',
        detail: `运行时 ${runtime}，工作目录不存在：${cwd}`,
      };
    } catch (err) {
      return {
        name: 'runtime',
        status: 'warn',
        detail: `运行时检查失败：${err.message}`,
      };
    }
  } catch (err) {
    return {
      name: 'runtime',
      status: 'fail',
      detail: `runtime 检查异常：${err.message}`,
    };
  }
}

/**
 * 检查日志文件是否存在
 * @param {Object} ctx - 应用上下文
 * @returns {Object} 检查结果
 */
function checkLogFiles(ctx) {
  const dataDir = ctx.dataDir || '';
  const dataDirLogsDir = path.join(dataDir, 'logs');
  const cwdLogsDir = path.join(process.cwd(), 'logs');

  try {
    const logsDir = fs.existsSync(dataDirLogsDir) ? dataDirLogsDir : cwdLogsDir;

    if (!fs.existsSync(logsDir)) {
      return {
        name: 'log_files',
        status: 'warn',
        detail: '日志目录不存在',
      };
    }

    const mainLog = path.join(logsDir, LOG_FILE_OUT);
    const errLog = path.join(logsDir, LOG_FILE_ERR);
    const mainExists = fs.existsSync(mainLog);
    const errExists = fs.existsSync(errLog);

    if (mainExists && errExists) {
      return {
        name: 'log_files',
        status: 'pass',
        detail: '主日志和错误日志文件均存在',
      };
    }

    const missing = [];
    if (!mainExists) missing.push(LOG_FILE_OUT);
    if (!errExists) missing.push(LOG_FILE_ERR);

    return {
      name: 'log_files',
      status: missing.length === 2 ? 'fail' : 'warn',
      detail: `日志文件缺失：${missing.join('、')}`,
    };
  } catch (err) {
    return {
      name: 'log_files',
      status: 'fail',
      detail: `日志检查异常：${err.message}`,
    };
  }
}

/**
 * 检查是否有孤立路由绑定
 * @param {Object} ctx - 应用上下文
 * @returns {Object} 检查结果
 */
function checkDanglingRoutes(ctx) {
  try {
    const routeAdminModule = ctx.routeAdmin;
    if (!routeAdminModule || !ctx.sessionService) {
      return {
        name: 'dangling_routes',
        status: 'warn',
        detail: 'route 管理模块或 session 服务未提供',
      };
    }

    const dangling = routeAdminModule.detectDangling(ctx);
    if (dangling.length === 0) {
      return {
        name: 'dangling_routes',
        status: 'pass',
        detail: '无孤立路由绑定',
      };
    }

    return {
      name: 'dangling_routes',
      status: 'warn',
      detail: `发现 ${dangling.length} 个孤立路由绑定`,
      items: dangling,
    };
  } catch (err) {
    return {
      name: 'dangling_routes',
      status: 'fail',
      detail: `孤立路由检查异常：${err.message}`,
    };
  }
}

/**
 * 检查 Node.js 版本是否符合要求
 * @param {Object} ctx - 应用上下文
 * @returns {Object} 检查结果
 */
function checkNodeVersion(_ctx) {
  try {
    const version = process.version;
    const major = parseInt(version.slice(1).split('.')[0], 10);
    const minVersion = 16;

    if (major >= minVersion) {
      return {
        name: 'node_version',
        status: 'pass',
        detail: `Node.js ${version}（要求 >= ${minVersion}）`,
      };
    }

    return {
      name: 'node_version',
      status: 'warn',
      detail: `Node.js ${version} 版本较低，建议升级到 ${minVersion}+`,
    };
  } catch (err) {
    return {
      name: 'node_version',
      status: 'fail',
      detail: `Node.js 版本检查异常：${err.message}`,
    };
  }
}

/**
 * 检查进程内存使用情况
 * @param {Object} ctx - 应用上下文
 * @returns {Object} 检查结果
 */
function checkMemoryUsage(_ctx) {
  try {
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    const rssMB = Math.round(memUsage.rss / 1024 / 1024);
    const usagePercent = Math.round((heapUsedMB / heapTotalMB) * 100);

    if (usagePercent < 70) {
      return {
        name: 'memory_usage',
        status: 'pass',
        detail: `堆内存 ${heapUsedMB}/${heapTotalMB} MB（${usagePercent}%），RSS ${rssMB} MB`,
      };
    }

    if (usagePercent < 85) {
      return {
        name: 'memory_usage',
        status: 'warn',
        detail: `堆内存使用率较高：${heapUsedMB}/${heapTotalMB} MB（${usagePercent}%）`,
      };
    }

    return {
      name: 'memory_usage',
      status: 'fail',
      detail: `堆内存使用率过高：${heapUsedMB}/${heapTotalMB} MB（${usagePercent}%），可能导致性能问题`,
    };
  } catch (err) {
    return {
      name: 'memory_usage',
      status: 'fail',
      detail: `内存检查异常：${err.message}`,
    };
  }
}

/**
 * 检查数据目录所在磁盘的剩余空间
 * @param {Object} ctx - 应用上下文
 * @returns {Object} 检查结果
 */
function checkDiskSpace(ctx) {
  try {
    const dataDir = ctx.dataDir || process.cwd();
    const stats = fs.statfsSync(dataDir);
    const freeGB = Math.round((stats.bsize * stats.bavail) / 1024 / 1024 / 1024);
    const totalGB = Math.round((stats.bsize * stats.blocks) / 1024 / 1024 / 1024);
    const usagePercent = Math.round(((totalGB - freeGB) / totalGB) * 100);

    if (freeGB > 10) {
      return {
        name: 'disk_space',
        status: 'pass',
        detail: `磁盘剩余 ${freeGB} GB（共 ${totalGB} GB，使用 ${usagePercent}%）`,
      };
    }

    if (freeGB > 2) {
      return {
        name: 'disk_space',
        status: 'warn',
        detail: `磁盘空间不足：剩余 ${freeGB} GB（共 ${totalGB} GB）`,
      };
    }

    return {
      name: 'disk_space',
      status: 'fail',
      detail: `磁盘空间严重不足：仅剩 ${freeGB} GB，可能影响日志写入和数据存储`,
    };
  } catch (err) {
    return {
      name: 'disk_space',
      status: 'warn',
      detail: `磁盘空间检查失败：${err.message}`,
    };
  }
}

/**
 * 检查 admin 服务端口是否被占用
 * @param {Object} ctx - 应用上下文
 * @returns {Object} 检查结果
 */
function checkPortStatus(ctx) {
  try {
    const envConfig = ctx.envConfig || {};
    const port = envConfig.adminPort || envConfig.port || 3000;

    const server = net.createServer();

    return new Promise((resolve) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          resolve({
            name: 'port_status',
            status: 'pass',
            detail: `端口 ${port} 正在使用中（服务已启动）`,
          });
        } else {
          resolve({
            name: 'port_status',
            status: 'warn',
            detail: `端口检查异常：${err.message}`,
          });
        }
      });

      server.once('listening', () => {
        server.close();
        resolve({
          name: 'port_status',
          status: 'warn',
          detail: `端口 ${port} 未被占用（服务可能未启动）`,
        });
      });

      server.listen(port, '127.0.0.1');
    });
  } catch (err) {
    return {
      name: 'port_status',
      status: 'warn',
      detail: `端口检查异常：${err.message}`,
    };
  }
}

module.exports = {
  runHealthCheck,
  getHealthHistory,
  clearHealthHistory,
  checkFeishuCredentials,
  checkDataDirectory,
  checkJsonFiles,
  checkOpenCode,
  checkRuntime,
  checkLogFiles,
  checkDanglingRoutes,
  checkNodeVersion,
  checkMemoryUsage,
  checkDiskSpace,
  checkPortStatus,
};
