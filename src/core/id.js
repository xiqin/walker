const crypto = require('crypto');
const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function createId(prefix) {
  const ts = Date.now();
  const timePart = encodeUlidTime(ts);
  const randPart = randomUlid(10);
  return prefix + timePart + randPart;
}

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

function randomUlid(len) {
  let s = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) {
    s += ULID_CHARS[bytes[i] % ULID_CHARS.length];
  }
  return s;
}

module.exports = { createId };
