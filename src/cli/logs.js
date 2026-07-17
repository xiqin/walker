'use strict';

const fs = require('fs');
const { OUT_LOG, ERR_LOG } = require('./daemon');

function tail(file, n) {
  if (!fs.existsSync(file)) return '';
  const content = fs.readFileSync(file, 'utf8');
  if (!content) return '';
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n');
}

function run(argv) {
  let n = 80;
  if (argv.length > 0) {
    const parsed = Number(argv[0]);
    if (Number.isFinite(parsed) && parsed > 0) n = parsed;
  }
  const out = tail(OUT_LOG, n);
  const err = tail(ERR_LOG, n);
  if (out) {
    console.log('--- stdout ---');
    console.log(out);
  }
  if (err) {
    console.log('--- stderr ---');
    console.log(err);
  }
  if (!out && !err) {
    console.log('no logs found at:');
    console.log('  ' + OUT_LOG);
    console.log('  ' + ERR_LOG);
  }
  return Promise.resolve(0);
}

module.exports = { run };
