'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 3000;
const MINIMAL_ENV_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'COMSPEC', 'HOME', 'USERPROFILE'];

function buildMinimalEnv(env) {
  const source = env || process.env;
  const result = {};
  for (const key of MINIMAL_ENV_KEYS) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

/**
 * 在当前系统 PATH 中解析命令路径。
 * @param {string} command - 命令名称。
 * @param {Object} [options] - 解析选项。
 * @returns {Promise<string|null>} 可执行路径，未找到返回 null。
 */
function defaultResolveCommand(command, options) {
  const opts = options || {};
  if (isPathLikeCommand(command)) {
    return Promise.resolve(fs.existsSync(command) ? command : null);
  }
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  const args = [command];
  const execute = opts.runCommand || runCommand;
  return execute(lookup, args, { ...opts, env: buildMinimalEnv(opts.env) }).then((result) => {
    const lines = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const first = process.platform === 'win32' ? pickWindowsExecutable(lines) : lines[0];
    return first || null;
  }).catch(() => null);
}

function isPathLikeCommand(command) {
  const value = String(command || '');
  return path.isAbsolute(value) || value.includes('/') || value.includes('\\');
}

function pickWindowsExecutable(lines) {
  return lines.find((line) => /\.(exe|com)$/i.test(line)) || lines.find((line) => /\.(cmd|bat)$/i.test(line)) || lines[0];
}

/**
 * 执行外部命令并返回 stdout/stderr。
 * @param {string} command - 可执行文件路径或命令。
 * @param {string[]} [args] - 参数列表。
 * @param {Object} [options] - 执行选项。
 * @returns {Promise<{stdout:string, stderr:string}>} 命令输出。
 */
function runCommand(command, args, options) {
  const opts = options || {};
  const execute = opts.execFile || execFile;
  return new Promise((resolve, reject) => {
    const child = execute(command, args || [], { timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS, env: buildMinimalEnv(opts.env) }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
    if (child && child.stdin) child.stdin.end();
  });
}

/**
 * 检测单个 provider 的安装、版本和基础健康状态。
 * @param {Object} provider - provider catalog 元信息。
 * @param {Object} [options] - 可注入检测依赖。
 * @returns {Promise<Object>} 结构化检测结果。
 */
async function detectProvider(provider, options) {
  const opts = options || {};
  const problems = [];
  const suggestions = [];
  const resolveCommand = opts.resolveCommand || defaultResolveCommand;
  const execute = opts.runCommand || runCommand;
  const checkHealth = opts.checkHealth;

  if (provider.id === 'shell') {
    return baseResult(provider, {
      installed: true,
      executablePath: process.env.COMSPEC || process.env.SHELL || 'shell',
      version: process.env.COMSPEC || process.env.SHELL || 'builtin',
      healthy: true,
      health: { status: 'healthy', summary: 'built-in shell provider is available' },
      problems,
      suggestions,
    });
  }

  let executablePath = null;
  for (const candidate of provider.executableCandidates) {
    executablePath = await resolveCommand(candidate, opts);
    if (executablePath) break;
  }

  if (!executablePath) {
    problems.push({ code: 'COMMAND_NOT_FOUND', message: provider.id + ' command was not found in PATH' });
    suggestions.push('Install ' + provider.label + ' and ensure its command is available in PATH.');
    return baseResult(provider, { installed: false, executablePath: '', version: '', healthy: false, health: { status: 'failed', summary: 'command not found' }, problems, suggestions });
  }

  let version = '';
  if (provider.versionCommand) {
    try {
      const output = await execute(executablePath, provider.versionCommand.args, opts);
      version = String(output.stdout || output.stderr || '').trim();
    } catch (err) {
      problems.push({ code: 'VERSION_FAILED', message: err.message });
      suggestions.push('Run `' + provider.executableCandidates[0] + ' --version` manually to verify the installation.');
    }
  }

  let healthy = problems.length === 0;
  let healthSummary = healthy ? 'provider command is available' : 'provider command check failed';
  if (checkHealth) {
    try {
      const healthResult = await checkHealth(provider, { executablePath, version });
      healthy = problems.length === 0 && (healthResult === true || (healthResult && healthResult.healthy === true));
      healthSummary = healthResult && healthResult.summary ? healthResult.summary : (healthy ? 'provider health check passed' : 'provider health check failed');
      if (!healthy) {
        problems.push({ code: 'HEALTH_CHECK_FAILED', message: healthSummary });
        suggestions.push('Check ' + provider.label + ' configuration and service availability.');
      }
    } catch (err) {
      healthy = false;
      problems.push({ code: 'HEALTH_CHECK_FAILED', message: err.message });
      suggestions.push('Check ' + provider.label + ' configuration and service availability.');
      healthSummary = err.message;
    }
  }

  return baseResult(provider, {
    installed: true,
    executablePath,
    version,
    healthy,
    health: { status: healthy ? 'healthy' : 'failed', summary: healthSummary },
    problems,
    suggestions,
  });
}

/**
 * 组装 provider 检测基础响应。
 * @param {Object} provider - provider catalog 元信息。
 * @param {Object} state - 检测状态字段。
 * @returns {Object} provider 检测响应。
 */
function baseResult(provider, state) {
  return {
    id: provider.id,
    label: provider.label,
    driver: provider.driver,
    capabilities: { ...provider.capabilities },
    configKeys: provider.configKeys.slice(),
    installed: state.installed,
    executablePath: state.executablePath,
    version: state.version,
    healthy: state.healthy,
    health: state.health,
    problems: state.problems,
    suggestions: state.suggestions,
  };
}

module.exports = { detectProvider, defaultResolveCommand, runCommand, buildMinimalEnv };
