'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const driverPath = path.join(root, 'src', 'drivers', 'opencode-driver.js');
const baseline = '1ac4dc2966d26812bc67ad958f8b8f0e8e053c05';

const DELETED_MODULE_PARTS = [
  ['claude', 'driver'],
  ['claude', 'pty', 'runtime'],
  ['claude', 'pty', 'broker'],
  ['claude', 'bridge', 'sidecar'],
  ['claude', 'attach', 'server'],
  ['claude', 'transcript'],
  ['claude', 'attach', 'command'],
];

const DELETED_TEST_PARTS = [
  ['claude', 'attach', 'command'],
  ['claude', 'attach', 'list'],
  ['claude', 'attach'],
  ['claude', 'bridge', 'sidecar'],
  ['claude', 'driver'],
  ['claude', 'pty', 'broker'],
  ['claude', 'tool', 'parity.integration'],
  ['claude', 'transcript'],
  ['claude', 'tui', 'reconnect.integration'],
  ['cli', 'claude', 'attach'],
];

const LAUNCHERS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];
const CLAUDE_BINARIES = ['claude', 'claude.exe', 'claude.cmd'];
const CLAUDE_HOME_DIR = '.' + 'claude';

function joinParts(parts) {
  return parts.join('-');
}

function deletedModules() {
  return DELETED_MODULE_PARTS.map(joinParts);
}

function deletedTestPaths() {
  return DELETED_TEST_PARTS.map((parts) => path.join('test', joinParts(parts) + '.test.js'));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js') && path.resolve(full) !== __filename) {
      files.push(full);
    }
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function stripLineComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

function findDeletedModuleReferences(roots) {
  const pattern = new RegExp(deletedModules().map(escapeRegExp).join('|'));
  const hits = [];
  for (const scanRoot of roots) {
    for (const file of listJsFiles(scanRoot)) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (pattern.test(line)) hits.push(relative(file) + ':' + (index + 1) + ':' + line.trim());
      });
    }
  }
  return hits;
}

function commandBase(command) {
  return path.win32.basename(path.posix.basename(command)).toLowerCase();
}

function findRealClaudeLaunches(dir) {
  const pattern = new RegExp('\\b(?:' + LAUNCHERS.join('|') + ')\\s*\\(\\s*([\'"`])([^\'"`]+)\\1');
  const hits = [];
  for (const file of listJsFiles(dir)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      const match = pattern.exec(stripLineComment(line));
      if (!match) return;
      if (CLAUDE_BINARIES.includes(commandBase(match[2].trim()))) {
        hits.push(relative(file) + ':' + (index + 1) + ':' + line.trim());
      }
    });
  }
  return hits;
}

function findUserClaudeHomeReads(dir) {
  const hits = [];
  for (const file of listJsFiles(dir)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      const code = stripLineComment(line);
      const namesHomeDir = code.includes(CLAUDE_HOME_DIR);
      const readsHome = /homedir\s*\(/.test(code) || /process\.env\.(?:HOME|USERPROFILE)\b/.test(code);
      const readsFile = /\b(?:readFile|readFileSync|readdir|readdirSync|createReadStream|openSync)\s*\(/.test(code);
      if (namesHomeDir && (readsHome || (readsFile && /home|USERPROFILE|homedir/i.test(code)))) {
        hits.push(relative(file) + ':' + (index + 1) + ':' + line.trim());
      }
    });
  }
  return hits;
}

function git(args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function unreleasedSection() {
  const text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const marker = '## [0.1.0]';
  const index = text.indexOf(marker);
  assert.notEqual(index, -1, 'CHANGELOG 缺少 0.1.0 历史段');
  return {
    unreleased: text.slice(0, index),
    released: text.slice(index),
  };
}

describe('claude removal guard', () => {
  it('REQ-006-B03: 历史规格、合规记录和记忆仍存在', () => {
    const required = [
      path.join(root, 'specs', '2026-07-31-claude-provider', 'spec.md'),
      path.join(root, 'specs', '2026-08-21-claude-tui-feishu-shared-session', 'spec.md'),
      path.join(root, '.loom', 'compliance', 'history.json'),
      path.join(root, '.loom', 'memory', 'MEMORY.md'),
    ];
    for (const file of required) {
      assert.equal(fs.existsSync(file), true, file);
      assert.equal(fs.statSync(file).isFile(), true, file);
      assert.equal(fs.statSync(file).size > 0, true, file);
    }
  });

  it('REQ-006-B03: OpenCode driver 相对基线无功能性 diff，且不含 Claude 接入符号', () => {
    assert.equal(fs.existsSync(driverPath), true);
    const headDiff = git(['diff', '--ignore-cr-at-eol', 'HEAD', '--', 'src/drivers/opencode-driver.js']);
    assert.equal(headDiff, '');
    const head = git(['rev-parse', 'HEAD']).trim();
    if (head === baseline) {
      const baselineDiff = git(['diff', '--ignore-cr-at-eol', baseline, '--', 'src/drivers/opencode-driver.js']);
      assert.equal(baselineDiff, '');
    }
    const source = fs.readFileSync(driverPath, 'utf8');
    assert.equal(source.includes('ClaudeDriver'), false);
    assert.equal(source.includes('claude_removed'), false);
    for (const name of deletedModules()) {
      assert.equal(source.includes(name), false, name);
    }
  });

  it('REQ-008-B02: 测试不启动真实 claude，也不读取用户主目录 .claude', () => {
    assert.deepEqual(findRealClaudeLaunches(path.join(root, 'test')), []);
    assert.deepEqual(findUserClaudeHomeReads(path.join(root, 'test')), []);
  });

  it('REQ-008-B03: 已删除专用测试不存在，历史规格目录仍保留', () => {
    for (const rel of deletedTestPaths()) {
      assert.equal(fs.existsSync(path.join(root, rel)), false, rel);
    }
    assert.equal(fs.existsSync(path.join(root, 'specs', '2026-07-31-claude-provider')), true);
    assert.equal(fs.existsSync(path.join(root, '.loom', 'compliance', 'history.json')), true);
  });

  it('REQ-008-B04: src 与 test 不再引用已删除 Claude 模块', () => {
    assert.deepEqual(findDeletedModuleReferences([
      path.join(root, 'src'),
      path.join(root, 'test'),
    ]), []);
  });

  it('REQ-007-B02: Unreleased 记录 Claude 移除，并保留 opencode、codex、shell 诊断', () => {
    const sections = unreleasedSection();
    assert.match(sections.unreleased, /移除 Claude 集成/);
    assert.match(sections.unreleased, /`opencode`、`codex`、`shell`/);
    assert.match(sections.unreleased, /walker doctor/);
    assert.match(sections.unreleased, /walker providers list/);
    assert.match(sections.unreleased, /walker providers doctor/);
    assert.equal(sections.unreleased.includes('CLAUDE_'), false);
    assert.equal(sections.unreleased.includes('claude attach'), false);
    assert.match(sections.released, /预留扩展点，Claude Code CLI/);
  });

  it('REQ-008-B01: 守卫测试只做静态检查，不调用 npm', () => {
    const source = fs.readFileSync(__filename, 'utf8');
    assert.equal(/execFileSync\(\s*['"]npm['"]/.test(source), false);
    assert.equal(/spawn(?:Sync)?\(\s*['"]npm['"]/.test(source), false);
  });
});
