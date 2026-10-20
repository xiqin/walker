'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function defaultServicePath() {
  const stateRoot = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(stateRoot, 'opencode', 'service.json');
}

function readServiceRecord(filePath) {
  const target = filePath || defaultServicePath();
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      id: parsed.id || '',
      version: parsed.version || '',
      url: typeof parsed.url === 'string' ? parsed.url.trim() : '',
      pid: parsed.pid,
      password: typeof parsed.password === 'string' ? parsed.password : '',
    };
  } catch (_) {
    return null;
  }
}

function canonicalUrl(value) {
  const url = new URL(value);
  let hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost') hostname = '127.0.0.1';
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const pathname = url.pathname.replace(/\/+$/, '');
  return url.protocol + '//' + hostname + ':' + port + pathname;
}

function urlsMatch(left, right) {
  if (!left || !right) return false;
  try {
    return canonicalUrl(left) === canonicalUrl(right);
  } catch (_) {
    return String(left).replace(/\/+$/, '') === String(right).replace(/\/+$/, '');
  }
}

function basicAuthHeader(password) {
  if (!password) return '';
  return 'Basic ' + Buffer.from('opencode:' + password, 'utf8').toString('base64');
}

/**
 * 未配置 URL 时采用 service.json；显式 URL 只在与发现结果一致，或调用方提供了密码时才带鉴权。
 */
function resolveOpencodeEndpoint(options) {
  const configuredUrl = String((options && options.configuredUrl) || '').trim();
  const configuredPassword = String((options && options.configuredPassword) || '');
  const record = options && Object.prototype.hasOwnProperty.call(options, 'serviceRecord')
    ? options.serviceRecord
    : readServiceRecord(options && options.servicePath);
  const discoveredUrl = record && record.url ? String(record.url).trim() : '';
  const discoveredPassword = record && record.password ? String(record.password) : '';

  if (!configuredUrl) {
    return {
      serverUrl: discoveredUrl,
      password: configuredPassword || discoveredPassword,
      discovered: Boolean(discoveredUrl),
    };
  }

  const password = configuredPassword || (urlsMatch(configuredUrl, discoveredUrl) ? discoveredPassword : '');
  return {
    serverUrl: configuredUrl,
    password,
    discovered: false,
  };
}

module.exports = {
  defaultServicePath,
  readServiceRecord,
  urlsMatch,
  basicAuthHeader,
  resolveOpencodeEndpoint,
};
