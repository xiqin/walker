'use strict';

const fs = require('fs');
const path = require('path');

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
  const checks = [];

  checks.push(checkFeishuCredentials(ctx));
  checks.push(checkDataDirectory(ctx));
  checks.push(checkJsonFiles(ctx));
  checks.push(await checkOpenCode(ctx));
  checks.push(checkRuntime(ctx));
  checks.push(checkLogFiles(ctx));
  checks.push(checkDanglingRoutes(ctx));

  return checks;
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
  const logsDir = path.join(dataDir, 'logs');

  try {
    if (!fs.existsSync(logsDir)) {
      return {
        name: 'log_files',
        status: 'warn',
        detail: '日志目录不存在',
      };
    }

    const outLog = path.join(logsDir, 'walker-out.log');
    const errLog = path.join(logsDir, 'walker-err.log');
    const outExists = fs.existsSync(outLog);
    const errExists = fs.existsSync(errLog);

    if (outExists && errExists) {
      return {
        name: 'log_files',
        status: 'pass',
        detail: 'stdout 和 stderr 日志文件均存在',
      };
    }

    const missing = [];
    if (!outExists) missing.push('walker-out.log');
    if (!errExists) missing.push('walker-err.log');

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

module.exports = {
  runHealthCheck,
  checkFeishuCredentials,
  checkDataDirectory,
  checkJsonFiles,
  checkOpenCode,
  checkRuntime,
  checkLogFiles,
  checkDanglingRoutes,
};
