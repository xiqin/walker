'use strict';

// 本规格最终只读检查：不执行产品测试、探针、真实服务或用户数据库操作。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const root = process.cwd();
const spec = path.resolve(__dirname, '..');
const output = process.argv[2];
assert.ok(output && !fs.existsSync(output), '必须使用全新日志路径');
const fd = fs.openSync(output, 'wx');

// 将检查命令与输出原始字节写入本次新日志，非零退出立即阻断。
function run(command, args, input) {
  fs.writeSync(fd, JSON.stringify({ command, args }) + '\n');
  const result = spawnSync(command, args, { cwd: root, input, stdio: [input ? 'pipe' : 'ignore', fd, fd] });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command}退出非零`);
}

// 计算实际文件字节指纹；不修改或重新编码历史证据。
function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// 遍历源码文件，仅进行语法解析，不加载模块执行。
function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : entry.name.endsWith('.js') ? [file] : [];
  });
}

try {
  fs.writeSync(fd, JSON.stringify({ time: new Date().toISOString(), node: process.version,
    cwd: root, tests_rerun: false, service_started: false }) + '\n');
  const expected = new Map();
  for (const name of ['T1', 'T2']) {
    const handoff = JSON.parse(fs.readFileSync(path.join(spec, 'handoffs', `${name}.json`), 'utf8'));
    for (const [file, fingerprint] of Object.entries(handoff.artifact_fingerprints)) {
      if (/^(src|test)\//.test(file)) expected.set(file, fingerprint);
    }
  }
  const review = fs.readFileSync(path.join(spec, 'evidence/T3-review-round2.md'), 'utf8');
  for (const match of review.matchAll(/\| `(test\/[^`]+)`[^|]*\| `([a-f0-9]{64})` \|/g)) {
    expected.set(match[1], match[2]);
  }
  assert.equal(expected.size, 10, '必须覆盖三份生产文件和七份测试文件');
  for (const [file, fingerprint] of expected) {
    const actual = hash(path.join(root, file));
    assert.equal(actual, fingerprint, `${file}与独立审查版本不同`);
    fs.writeSync(fd, JSON.stringify({ unchanged_reviewed_file: file, sha256: actual }) + '\n');
  }
  run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run lint']);
  const files = sourceFiles(path.join(root, 'src')).sort();
  const browserModulesDir = path.join(root, 'src', 'admin', 'public', 'js');
  for (const file of files) {
    // 与项目scripts/check.js一致：浏览器模块按ESM解析，其他源码按包模式解析。
    if (file.startsWith(browserModulesDir + path.sep)) {
      fs.writeSync(fd, JSON.stringify({ browser_module: file }) + '\n');
      run(process.execPath, ['--input-type=module', '--check'], fs.readFileSync(file));
    } else {
      run(process.execPath, ['--check', file]);
    }
  }
  fs.writeSync(fd, JSON.stringify({ syntax_files: files.length, passed: true }) + '\n');
  run(process.execPath, [path.join(__dirname, 'check-ledger.cjs')]);
  run('git', ['diff', '--check']);
  const diff = execFileSync('git', ['diff', 'HEAD', '--', 'src', 'test'], { cwd: root, encoding: 'utf8' });
  const placeholders = diff.split(/\r?\n/).filter(line => line.startsWith('+') &&
    !line.startsWith('+++') && /\b(TBD|TODO|implement later|fill in details)\b/i.test(line));
  fs.writeSync(fd, JSON.stringify({ added_code_placeholders: placeholders }) + '\n');
  assert.equal(placeholders.length, 0, '新增代码存在占位符');
  const gitTree = execFileSync('git', ['log', '-1', '--format=%T'], { cwd: root, encoding: 'utf8' }).trim();
  const gitDiff = execFileSync('git', ['diff', 'HEAD', '--', '.',
    ':(exclude)specs/2026-11-17-feishu-real-session-title/**'], { cwd: root });
  const diffHash = crypto.createHash('sha256').update(gitDiff).digest('hex');
  fs.writeSync(fd, JSON.stringify({ git_tree: gitTree, diff_sha256: diffHash }) + '\n');
  for (const file of ['targeted-isolated.log', 'integration-isolated.log', 'question-isolated-fixed.log',
    'full-isolated-retry.log', 'fixed.json', 'T3-review-round2.md', 'converge-semantic-review.md']) {
    fs.writeSync(fd, JSON.stringify({ evidence: file, sha256: hash(path.join(__dirname, file)) }) + '\n');
  }
  fs.writeSync(fd, JSON.stringify({ exit_code: 0, passed: true, tests_rerun: false }) + '\n');
} catch (error) {
  fs.writeSync(fd, String(error.stack || error) + '\n' + JSON.stringify({ exit_code: 1, passed: false }) + '\n');
  process.exitCode = 1;
} finally {
  fs.closeSync(fd);
}
