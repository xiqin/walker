const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { MessageDedup } = require('../src/core/message-dedup');
const { JsonStore } = require('../src/core/json-store');

describe('MessageDedup', () => {
  it('新消息返回 false（未重复）', () => {
    const dedup = new MessageDedup({ windowMs: 300000 });
    assert.equal(dedup.isDuplicate('om_abc123'), false);
  });

  it('相同 messageId 在窗口期内返回 true（重复）', () => {
    const dedup = new MessageDedup({ windowMs: 300000 });
    dedup.isDuplicate('om_abc123');
    assert.equal(dedup.isDuplicate('om_abc123'), true);
  });

  it('不同 messageId 不互相重复', () => {
    const dedup = new MessageDedup({ windowMs: 300000 });
    dedup.isDuplicate('om_abc123');
    assert.equal(dedup.isDuplicate('om_def456'), false);
  });

  it('超过窗口期的 messageId 不再重复', () => {
    const dedup = new MessageDedup({ windowMs: 100 });
    dedup.isDuplicate('om_old');
    const start = Date.now();
    while (Date.now() - start < 200) { ; }
    assert.equal(dedup.isDuplicate('om_old'), false);
  });

  it('过期条目被清理', () => {
    const dedup = new MessageDedup({ windowMs: 100 });
    dedup.isDuplicate('om_old1');
    dedup.isDuplicate('om_old2');
    const start = Date.now();
    while (Date.now() - start < 200) { ; }
    dedup.isDuplicate('om_new');
    assert.equal(dedup.size(), 1);
  });

  it('陈旧消息（createTime 超过阈值）被拒绝', () => {
    const dedup = new MessageDedup({ windowMs: 300000, staleThresholdMs: 1000 });
    const staleCreateTime = Date.now() - 5000;
    assert.equal(dedup.isDuplicate('om_stale', staleCreateTime), true);
  });

  it('非陈旧消息（createTime 在阈值内）正常通过', () => {
    const dedup = new MessageDedup({ windowMs: 300000, staleThresholdMs: 10000 });
    const freshCreateTime = Date.now() - 500;
    assert.equal(dedup.isDuplicate('om_fresh', freshCreateTime), false);
  });

  it('无 createTime 时不做陈旧检查', () => {
    const dedup = new MessageDedup({ windowMs: 300000, staleThresholdMs: 1000 });
    assert.equal(dedup.isDuplicate('om_no_time'), false);
  });

  it('staleThresholdMs 默认等于 windowMs', () => {
    const dedup = new MessageDedup({ windowMs: 300000 });
    assert.equal(dedup._staleThresholdMs, 300000);
  });

  it('带 store 时持久化去重记录', async () => {
    const tmpDir = path.join(os.tmpdir(), 'walker-dedup-test-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const storePath = path.join(tmpDir, 'dedup.json');
    const store = new JsonStore(storePath, {});
    const dedup = new MessageDedup({ windowMs: 300000, store });
    dedup.isDuplicate('om_persist1');
    await new Promise((r) => setTimeout(r, 1100));
    const stored = store.read();
    assert.ok(stored['om_persist1']);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('带 store 时从持久化恢复已有记录', () => {
    const tmpDir = path.join(os.tmpdir(), 'walker-dedup-test-restore-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const storePath = path.join(tmpDir, 'dedup.json');
    const store = new JsonStore(storePath, {});
    store.update((data) => { data['om_restored'] = Date.now() - 1000; });
    const dedup = new MessageDedup({ windowMs: 300000, store });
    assert.equal(dedup.isDuplicate('om_restored'), true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('命令 key 前缀不与文本 messageId 冲突', () => {
    const dedup = new MessageDedup({ windowMs: 300000 });
    dedup.isDuplicate('om_abc123');
    assert.equal(dedup.isDuplicate('cmd:om_abc123:delete'), false);
  });

  it('超过 cleanupThreshold 时触发清理', () => {
    const dedup = new MessageDedup({ windowMs: 300000, cleanupThreshold: 3 });
    dedup.isDuplicate('om_a');
    dedup.isDuplicate('om_b');
    dedup.isDuplicate('om_c');
    dedup.isDuplicate('om_d');
    assert.ok(dedup.size() <= 4);
  });
});
