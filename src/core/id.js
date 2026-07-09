const crypto = require('crypto');
/** ULID 编码字符集 */
const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 生成带前缀的 ULID 格式唯一标识符
 * @param {string} prefix - 标识符前缀，如 'wks_'
 * @returns {string} 前缀 + 时间编码 + 随机编码组成的唯一标识符
 */
function createId(prefix) {
  const ts = Date.now();
  const timePart = encodeUlidTime(ts);
  const randPart = randomUlid(10);
  return prefix + timePart + randPart;
}

/**
 * 将时间戳编码为 ULID 时间部分（8 个字符）
 * @param {number} ts - 毫秒级时间戳
 * @returns {string} 8 字符的 ULID 时间编码
 */
function encodeUlidTime(ts) {
  let encoded = '';
  let t = ts;
  for (let i = 7; i >= 0; i--) {
    const mod = t % ULID_CHARS.length;
    encoded = ULID_CHARS[mod] + encoded;
    t = Math.floor(t / ULID_CHARS.length);
  }
  return encoded;
}

/**
 * 生成指定长度的 ULID 随机部分
 * @param {number} len - 随机部分的字符长度
 * @returns {string} 随机编码字符串
 */
function randomUlid(len) {
  let s = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) {
    s += ULID_CHARS[bytes[i] % ULID_CHARS.length];
  }
  return s;
}

module.exports = { createId };
