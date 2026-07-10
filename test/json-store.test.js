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

test('JsonStore 文件缺失 fallback 不会被 update 原地污染', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-json-'));
  const filePath = path.join(tmpDir, 'data.json');
  const defaultValue = { items: [{ id: 'seed' }], meta: { count: 0 } };
  const store = new JsonStore(filePath, defaultValue);

  store.update((data) => {
    data.items.push({ id: 'written' });
    data.meta.count = 1;
  });
  fs.unlinkSync(filePath);

  const fallback = store.read();
  assert.deepEqual(fallback, { items: [{ id: 'seed' }], meta: { count: 0 } });
  assert.notStrictEqual(fallback, defaultValue);
  assert.notStrictEqual(fallback.items, defaultValue.items);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('JsonStore 损坏文件 fallback 不会复用历史变异对象', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-json-'));
  const filePath = path.join(tmpDir, 'data.json');
  const store = new JsonStore(filePath, { items: [], meta: { count: 0 } });

  const fallback = store.read();
  fallback.items.push({ id: 'local-mutation' });
  fallback.meta.count = 1;
  fs.writeFileSync(filePath, '{invalid json!!!', 'utf8');

  const damagedFallback = store.read();
  assert.deepEqual(damagedFallback, { items: [], meta: { count: 0 } });
  assert.notStrictEqual(damagedFallback, fallback);
  assert.notStrictEqual(damagedFallback.items, fallback.items);
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

test('JsonStore updateAsync 并发调用不丢失更新', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-json-'));
  const filePath = path.join(tmpDir, 'concurrent.json');
  const store = new JsonStore(filePath, { counter: 0 });

  const promises = [];
  for (let i = 0; i < 50; i++) {
    promises.push(store.updateAsync((d) => { d.counter += 1; }));
  }
  await Promise.all(promises);

  const data = store.read();
  assert.equal(data.counter, 50);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('JsonStore updateAsync 返回 Promise 可单独 await', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-json-'));
  const filePath = path.join(tmpDir, 'async_single.json');
  const store = new JsonStore(filePath, { value: 'a' });

  await store.updateAsync((d) => { d.value = 'b'; });
  const data = store.read();
  assert.equal(data.value, 'b');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
