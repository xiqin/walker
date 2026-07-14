const crypto = require('crypto');
const ID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function createId(prefix) {
  const safePrefix = typeof prefix === 'string' ? prefix : '';
  const ts = Date.now();
  const timePart = encodeTime(ts);
  const randPart = randomPart(10);
  return safePrefix + timePart + randPart;
}

function encodeTime(ts) {
  let encoded = '';
  let t = ts;
  for (let i = 7; i >= 0; i--) {
    const mod = t % ID_CHARS.length;
    encoded = ID_CHARS[mod] + encoded;
    t = Math.floor(t / ID_CHARS.length);
  }
  return encoded;
}

function randomPart(len) {
  let s = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) {
    s += ID_CHARS[bytes[i] % ID_CHARS.length];
  }
  return s;
}

module.exports = { createId };
