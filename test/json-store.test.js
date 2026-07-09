const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { JsonStore } = require('../src/core/json-store');

test('JsonStore 创建目录并读取默认值', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-json-'));
  const filePath = path.join(tmpDir, 'data.json');
  const store = new JsonStore(filePath, { items: [] });
  const data = store.read();
  assert.deepEqual(data, { items: [] });
  assert.ok(fs.existsSync(tmpDir));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('JsonStore 写入后重读', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-json-'));
  const filePath = path.join(tmpDir, 'data.json');
  const store = new JsonStore(filePath, { items: [] });
  store.write({ items: [{ id: 'wks_001', name: 'test' }] });
  const data = store.read();
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].id, 'wks_001');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('JsonStore update 修改部分字段', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-json-'));
  const filePath = path.join(tmpDir, 'data.json');
  const store = new JsonStore(filePath, { count: 0, label: 'init' });
  store.update((d) => { d.count += 1; d.label = 'updated'; });
  const data = store.read();
  assert.equal(data.count, 1);
  assert.equal(data.label, 'updated');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('JsonStore 损坏文件时返回默认值并记录错误', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-json-'));
  const filePath = path.join(tmpDir, 'data.json');
  fs.writeFileSync(filePath, '{invalid json!!!', 'utf8');
  const store = new JsonStore(filePath, { fallback: true });
  const data = store.read();
  assert.deepEqual(data, { fallback: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('JsonStore 子目录自动创建', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-json-'));
  const filePath = path.join(tmpDir, 'sub', 'deep', 'data.json');
  const store = new JsonStore(filePath, { nested: true });
  const data = store.read();
  assert.deepEqual(data, { nested: true });
  assert.ok(fs.existsSync(path.join(tmpDir, 'sub', 'deep')));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
