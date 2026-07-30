'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_MAX_ARCHIVES,
  DEFAULT_MAX_BYTES,
  rotateLogFile,
} = require('../src/core/log-rotation');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'walker-log-rotation-'));
}

test('低于阈值不轮转并保留原文件', () => {
  const dir = makeTempDir();
  const logPath = path.join(dir, 'walker.out.log');
  fs.writeFileSync(logPath, Buffer.alloc(DEFAULT_MAX_BYTES - 1));

  const result = rotateLogFile(logPath);

  assert.equal(result.ok, true);
  assert.equal(result.rotated, false);
  assert.equal(result.reason, 'below-threshold');
  assert.equal(fs.existsSync(logPath), true);
  assert.equal(fs.existsSync(`${logPath}.1`), false);
});

test('达到阈值生成 .1 且当前路径可继续写入', () => {
  const dir = makeTempDir();
  const logPath = path.join(dir, 'walker.out.log');
  fs.writeFileSync(logPath, Buffer.alloc(DEFAULT_MAX_BYTES));

  const result = rotateLogFile(logPath);
  fs.appendFileSync(logPath, 'next-line\n');

  assert.equal(result.ok, true);
  assert.equal(result.rotated, true);
  assert.equal(fs.statSync(`${logPath}.1`).size, DEFAULT_MAX_BYTES);
  assert.equal(fs.readFileSync(logPath, 'utf8'), 'next-line\n');
});

test('已有 5 个归档时再次轮转后仍只保留 5 个归档且最旧被删除', () => {
  const dir = makeTempDir();
  const logPath = path.join(dir, 'walker.out.log');
  fs.writeFileSync(logPath, 'current');
  for (let i = 1; i <= DEFAULT_MAX_ARCHIVES; i += 1) {
    fs.writeFileSync(`${logPath}.${i}`, `archive-${i}`);
  }

  const result = rotateLogFile(logPath, { maxBytes: 'current'.length });

  assert.equal(result.ok, true);
  assert.equal(result.rotated, true);
  for (let i = 1; i <= DEFAULT_MAX_ARCHIVES; i += 1) {
    assert.equal(fs.existsSync(`${logPath}.${i}`), true);
  }
  assert.equal(fs.existsSync(`${logPath}.${DEFAULT_MAX_ARCHIVES + 1}`), false);
  assert.equal(fs.readFileSync(`${logPath}.1`, 'utf8'), 'current');
  assert.equal(fs.readFileSync(`${logPath}.2`, 'utf8'), 'archive-1');
  assert.equal(fs.readFileSync(`${logPath}.5`, 'utf8'), 'archive-4');
});

test('模拟 FS 错误时不抛并返回错误结果', () => {
  const fakeFs = {
    statSync: () => ({ size: DEFAULT_MAX_BYTES }),
    existsSync: () => true,
    unlinkSync: () => {},
    renameSync: () => { throw new Error('rename failed'); },
  };

  let result;
  assert.doesNotThrow(() => {
    result = rotateLogFile('walker.out.log', { fs: fakeFs });
  });
  assert.equal(result.ok, false);
  assert.equal(result.rotated, false);
  assert.equal(result.reason, 'rename-failed');
  assert.match(result.error.message, /rename failed/);
});

test('实现使用 stat 判断大小且不读取完整日志内容', () => {
  let statCalled = false;
  let readFileCalled = false;
  const fakeFs = {
    statSync: () => {
      statCalled = true;
      return { size: DEFAULT_MAX_BYTES - 1 };
    },
    existsSync: () => false,
    unlinkSync: () => {},
    renameSync: () => {},
    readFileSync: () => {
      readFileCalled = true;
      throw new Error('readFileSync must not be called');
    },
  };

  const result = rotateLogFile('walker.out.log', { fs: fakeFs });

  assert.equal(result.ok, true);
  assert.equal(result.rotated, false);
  assert.equal(statCalled, true);
  assert.equal(readFileCalled, false);
});
