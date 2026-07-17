'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function collectJsFiles(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      result.push(full);
    }
  }
  return result;
}

function checkFile(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return null;
  } catch (err) {
    return file + '\n' + (err.stderr ? err.stderr.toString().trim() : err.message);
  }
}

const srcDir = path.join(root, 'src');
const files = collectJsFiles(srcDir).sort();
console.log('syntax-check ' + files.length + ' files under src/');

let failed = 0;
for (const file of files) {
  const err = checkFile(file);
  if (err) {
    failed++;
    console.error('FAIL ' + path.relative(root, file).replace(/\\/g, '/'));
    console.error(err);
  }
}

if (failed > 0) {
  console.error('\n' + failed + ' file(s) failed syntax check');
  process.exit(1);
}

console.log('syntax check passed');

console.log('\nrun tests...');
const testDir = path.join(root, 'test');
const testFiles = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.js'))
  .map(f => path.join('test', f));
try {
  execFileSync(process.execPath, ['--test', ...testFiles], { cwd: root, stdio: 'inherit' });
} catch (err) {
  process.exit(err.status || 1);
}
