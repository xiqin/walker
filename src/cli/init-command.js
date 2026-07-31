'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const outputTools = require('./cli-output');
const { safeWriteJson, assertExistingJsonReadable } = require('./safe-write');
const { installHookPlugin: defaultInstallHookPlugin } = require('../opencode-hook/installer');

function resolveDataDir(env, options) {
  const opts = options || {};
  const targetEnv = env || process.env;
  const targetPath = opts.path || path;
  const homeDir = opts.homeDir || os.homedir() || targetEnv.USERPROFILE || targetEnv.HOME || '.';
  const value = opts.dataDir || targetEnv.WALKER_DATA_DIR || targetPath.join(homeDir, '.walker');
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) return targetPath.join(homeDir, value.slice(2));
  return value;
}

function maskSecret(value) {
  if (!value) return 'missing';
  const text = String(value);
  if (text.length <= 8) return '[redacted]';
  return text.slice(0, 4) + '...' + text.slice(-4);
}

function createToken(targetCrypto) {
  const cryptoImpl = targetCrypto || crypto;
  if (typeof cryptoImpl.randomBytes === 'function') return cryptoImpl.randomBytes(24).toString('base64url');
  if (typeof cryptoImpl.randomUUID === 'function') return cryptoImpl.randomUUID().replace(/-/g, '');
  throw new Error('No secure token generator is available');
}

function configTemplate() {
  return {
    version: 1,
    admin: {
      host: '127.0.0.1',
      port: 8787,
      tokenEnv: 'WALKER_ADMIN_TOKEN',
    },
    providers: {
      default: 'opencode',
    },
    platforms: {},
  };
}

function writeMissingJson(filePath, value, deps) {
  const result = safeWriteJson(filePath, value, deps);
  return result.written ? 'created' : 'exists';
}

async function run(argv, options) {
  const args = argv || [];
  const opts = options || {};
  const targetFs = opts.fs || fs;
  const targetPath = opts.path || path;
  const output = opts.output || outputTools.createOutput();
  const env = opts.env || process.env;
  const dataDirArgIndex = args.indexOf('--data-dir');
  const dataDir = resolveDataDir(env, {
    path: targetPath,
    homeDir: opts.homeDir,
    dataDir: opts.dataDir || (dataDirArgIndex >= 0 ? args[dataDirArgIndex + 1] : ''),
  });
  const created = [];
  const preserved = [];

  try {
    if (dataDirArgIndex >= 0 && !args[dataDirArgIndex + 1]) throw new Error('--data-dir requires a path');
    targetFs.mkdirSync(dataDir, { recursive: true });
    for (const dirName of ['attachments', 'logs']) {
      const dirPath = targetPath.join(dataDir, dirName);
      const existed = exists(targetFs, dirPath);
      targetFs.mkdirSync(dirPath, { recursive: true });
      (existed ? preserved : created).push(dirName + '/');
    }

    const configPath = targetPath.join(dataDir, 'config.json');
    const statePath = targetPath.join(dataDir, 'state.json');
    const dedupPath = targetPath.join(dataDir, 'dedup.json');
    for (const jsonPath of [configPath, statePath, dedupPath]) assertExistingJsonReadable(jsonPath, { fs: targetFs });

    recordJson(created, preserved, 'state.json', writeMissingJson(statePath, { version: 1, routes: {}, sessions: {} }, { fs: targetFs, path: targetPath }));
    recordJson(created, preserved, 'dedup.json', writeMissingJson(dedupPath, { version: 1, messages: {} }, { fs: targetFs, path: targetPath }));
    recordJson(created, preserved, 'config.json', writeMissingJson(configPath, configTemplate(), { fs: targetFs, path: targetPath }));

    const token = env.WALKER_ADMIN_TOKEN || createToken(opts.crypto);
    const tokenSource = env.WALKER_ADMIN_TOKEN ? 'environment' : 'generated for this run only';
    const installHookPlugin = opts.installHookPlugin || defaultInstallHookPlugin;
    let pluginResult = { installed: false, reason: 'skipped' };
    if (opts.installPlugin !== false && typeof installHookPlugin === 'function') {
      pluginResult = await installHookPlugin({
        enabled: env.WALKER_OPENCODE_HOOK_ENABLED !== 'false',
        opencodeConfigDir: env.OPENCODE_CONFIG_DIR || undefined,
        walkerPort: parsePort(env.WALKER_ADMIN_PORT, 8787),
        walkerToken: env.WALKER_ADMIN_TOKEN || '',
      });
    }

    output.write('Walker init complete');
    outputTools.row(output, 'Data directory', dataDir);
    outputTools.row(output, 'admin token', maskSecret(token) + ' (' + tokenSource + ')');
    output.write('Set WALKER_ADMIN_TOKEN in your environment before starting Walker; init does not write shell profiles or services.');
    output.write('Third-party platform secrets were not written to config.json.');
    outputTools.row(output, 'created', created.length ? created.join(', ') : 'none');
    outputTools.row(output, 'preserved', preserved.length ? preserved.join(', ') : 'none');
    outputTools.row(output, 'OpenCode TUI plugin', summarizePlugin(pluginResult));

    return 0;
  } catch (err) {
    output.error('walker init failed: ' + err.message);
    return 1;
  }
}

function exists(targetFs, filePath) {
  try {
    targetFs.accessSync(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

function recordJson(created, preserved, name, status) {
  (status === 'created' ? created : preserved).push(name);
}

function parsePort(value, fallback) {
  const port = parseInt(value, 10);
  return Number.isFinite(port) && port > 0 ? port : fallback;
}

function summarizePlugin(result) {
  if (!result) return 'skipped';
  if (result.installed) return 'installed';
  return result.reason || 'checked';
}

module.exports = { run, resolveDataDir, maskSecret, configTemplate };
