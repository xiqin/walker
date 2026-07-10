const fs = require('fs');

const { EDITABLE_ENV_KEYS } = require('./config');

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
  if (str.includes(' ') || str.includes('#') || str.includes('=') || str.includes('"') || str.includes("'")) {
    return '"' + str.replace(/"/g, '\\"') + '"';
  }
  return str;
}

/**
 * 安全更新 .env 文件：只允许 allowlist 内字段，保留注释、空行和未知键
 * @param {string} envPath - .env 文件路径
 * @param {Object} updates - 待更新键值对
 * @returns {{ restartRequired: boolean, updatedKeys: string[] }}
 */
function updateDotEnv(envPath, updates) {
  const entries = updates || {};
  const keys = Object.keys(entries);
  for (const key of keys) {
    if (!EDITABLE_ENV_KEY_SET.has(key)) {
      throw new Error(`Environment key ${key} is not editable`);
    }
  }

  const updated = new Set();
  const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const trailingNewline = raw.endsWith('\n') || raw === '';
  const lines = raw ? raw.split(/\r?\n/) : [];
  if (raw && lines[lines.length - 1] === '') lines.pop();

  const nextLines = lines.map((line) => {
    const key = parseEnvKey(line);
    if (!key || !Object.prototype.hasOwnProperty.call(entries, key)) return line;
    updated.add(key);
    return `${key}=${stringifyEnvValue(entries[key])}`;
  });

  for (const key of keys) {
    if (!updated.has(key)) {
      nextLines.push(`${key}=${stringifyEnvValue(entries[key])}`);
    }
  }

  const nextRaw = nextLines.join('\n') + (trailingNewline ? '\n' : '');
  fs.writeFileSync(envPath, nextRaw, 'utf8');

  return {
    restartRequired: true,
    updatedKeys: keys,
  };
}

module.exports = { updateDotEnv };
