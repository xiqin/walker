const fs = require('fs');

const path = require('path');

const { EDITABLE_ENV_KEYS, CONFIG_DEFINITION_BY_KEY } = require('./config');

const EDITABLE_ENV_KEY_SET = new Set(EDITABLE_ENV_KEYS);

/**
 * 从 .env 行文本中提取键名
 * @param {string} line - 单行文本
 * @returns {string} 键名或空串
 */
function parseEnvKey(line) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match ? match[1] : '';
}

/**
 * 将任意值转为 .env 行值字符串
 * @param {*} value - 待写入值
 * @returns {string}
 */
function stringifyEnvValue(value) {
  const str = String(value);
  if (/[\r\n]/.test(str)) {
    throw new Error('Environment value cannot contain newlines');
  }
  if (str.includes(' ') || str.includes('#') || str.includes('=') || str.includes('"') || str.includes("'")) {
    return '"' + str.replace(/"/g, '\\"') + '"';
  }
  return str;
}

/**
 * 将 .env 文本拆为正文与原始行尾，避免重写非目标行字节。
 * @param {string} raw - 原始 .env 文本。
 * @returns {Array<{content:string, ending:string}>} 带原始行尾的行列表。
 */
function splitEnvLines(raw) {
  if (!raw) return [];
  const lines = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match;
  while ((match = pattern.exec(raw)) && (match[1] || match[2])) {
    lines.push({ content: match[1], ending: match[2] });
    if (!match[2]) break;
  }
  return lines;
}

/**
 * 按配置定义规范化并校验单个更新值。
 * @param {string} key - 环境变量名。
 * @param {*} value - 请求值。
 * @returns {string} 可写入的规范化字符串。
 */
function validateEnvValue(key, value) {
  if (value === null || value === undefined || typeof value === 'object') {
    throw new Error(`${key} 的值类型无效`);
  }
  const definition = CONFIG_DEFINITION_BY_KEY.get(key);
  const text = String(value);
  if (/\r|\n/.test(text)) throw new Error(`${key} 不能包含换行`);

  switch (definition && definition.type) {
    case 'boolean':
      if (!['true', 'false'].includes(text.toLowerCase())) throw new Error(`${key} 必须为 true 或 false`);
      return text.toLowerCase();
    case 'port': {
      const port = Number(text);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${key} 必须为 1-65535 的整数`);
      return String(port);
    }
    case 'positive-int': {
      const number = Number(text);
      if (!Number.isInteger(number) || number <= 0) throw new Error(`${key} 必须为正整数`);
      return String(number);
    }
    case 'host':
      if (!text.trim() || /[\s/\\]/.test(text)) throw new Error(`${key} 必须为有效主机名或 IP`);
      return text.trim();
    case 'runtime':
      if (!['windows', 'wsl'].includes(text)) throw new Error(`${key} 必须为 windows 或 wsl`);
      return text;
    case 'route-mode':
      if (!['thread', 'chat'].includes(text)) throw new Error(`${key} 必须为 thread 或 chat`);
      return text;
    case 'progress-style':
      if (!['card', 'reaction', 'none'].includes(text)) throw new Error(`${key} 值无效`);
      return text;
    case 'exit-action':
      if (!['cancel', 'stop', 'none'].includes(text)) throw new Error(`${key} 值无效`);
      return text;
    case 'claude-permission-mode':
      if (text === 'default') return '';
      if (!['', 'acceptEdits', 'auto', 'manual', 'dontAsk', 'plan', 'bypassPermissions'].includes(text)) throw new Error(`${key} 值无效`);
      return text;
    case 'list':
      validateListText(key, text);
      return text;
    case 'enum-list':
      validateListText(key, text, ['user', 'project', 'local']);
      return text;
    case 'json-list':
      validateJsonListText(key, text);
      return text;
    case 'json-object':
      validateJsonObjectText(key, text);
      return text;
    case 'url':
      if (text) {
        let parsed;
        try { parsed = new URL(text); } catch (_err) { throw new Error(`${key} 必须为有效 HTTP URL`); }
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${key} 必须为有效 HTTP URL`);
      }
      return text;
    case 'non-empty':
      if (!text.trim()) throw new Error(`${key} 不能为空`);
      return text;
    default:
      return text;
  }
}

function validateListText(key, text, allowedValues) {
  if (!text) return;
  const items = text.split(',').map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) throw new Error(`${key} 必须为逗号分隔列表`);
  if (allowedValues) {
    const allowed = new Set(allowedValues);
    if (!items.every((item) => allowed.has(item))) throw new Error(`${key} 值无效`);
  }
}

function validateJsonListText(key, text) {
  if (!text) return;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_err) {
    throw new Error(`${key} 必须为 JSON 字符串数组`);
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`${key} 必须为 JSON 字符串数组`);
  }
}

function validateJsonObjectText(key, text) {
  if (!text) return;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_err) {
    throw new Error(`${key} 必须为 JSON object`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${key} 必须为 JSON object`);
  }
}

/**
 * 安全更新 .env 文件：只允许 allowlist 内字段，保留注释、空行和未知键
 * @param {string} envPath - .env 文件路径
 * @param {Object} updates - 待更新键值对
 * @returns {{ restartRequired: boolean, updatedKeys: string[] }}
 */
function updateDotEnv(envPath, updates) {
  if (!envPath || typeof envPath !== 'string') {
    throw new Error('envPath must be a non-empty string');
  }
  const resolved = path.resolve(envPath);
  const dirname = path.dirname(resolved);
  if (!path.isAbsolute(dirname)) {
    throw new Error('envPath must resolve to an absolute path');
  }
  const entries = updates || {};
  const keys = Object.keys(entries);
  const normalizedEntries = {};
  for (const key of keys) {
    if (!EDITABLE_ENV_KEY_SET.has(key)) {
      throw new Error(`Environment key ${key} is not editable`);
    }
    normalizedEntries[key] = validateEnvValue(key, entries[key]);
  }

  const updated = new Set();
  const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const lines = splitEnvLines(raw);
  const lineEndingMatch = raw.match(/\r\n|\n|\r/);
  const lineEnding = lineEndingMatch ? lineEndingMatch[0] : '\n';
  const hadTrailingNewline = /(?:\r\n|\n|\r)$/.test(raw);

  const nextLines = lines.map((line) => {
    const key = parseEnvKey(line.content);
    if (!key || !Object.prototype.hasOwnProperty.call(entries, key)) return line;
    updated.add(key);
    return {
      content: `${key}=${stringifyEnvValue(normalizedEntries[key])}`,
      ending: line.ending,
    };
  });

  const missingKeys = keys.filter((key) => !updated.has(key));
  if (missingKeys.length > 0 && nextLines.length > 0 && !nextLines[nextLines.length - 1].ending) {
    nextLines[nextLines.length - 1].ending = lineEnding;
  }
  for (let index = 0; index < missingKeys.length; index += 1) {
    const key = missingKeys[index];
    const isLast = index === missingKeys.length - 1;
    nextLines.push({
      content: `${key}=${stringifyEnvValue(normalizedEntries[key])}`,
      ending: !isLast || hadTrailingNewline || raw === '' ? lineEnding : '',
    });
  }

  const nextRaw = nextLines.map((line) => line.content + line.ending).join('');
  const tempPath = path.join(dirname, `.${path.basename(resolved)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tempPath, nextRaw, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tempPath, resolved);
  } catch (err) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_cleanupError) {}
    throw err;
  }

  return {
    restartRequired: true,
    updatedKeys: keys,
    effectiveValues: normalizedEntries,
  };
}

module.exports = { updateDotEnv, validateEnvValue };
