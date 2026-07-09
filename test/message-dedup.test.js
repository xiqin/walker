const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { MessageDedup } = require('../src/core/message-dedup');

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
    while (Date.now() - start < 200) {}
    assert.equal(dedup.isDuplicate('om_old'), false);
  });

  it('过期条目被清理', () => {
    const dedup = new MessageDedup({ windowMs: 100 });
    dedup.isDuplicate('om_old1');
    dedup.isDuplicate('om_old2');
    const start = Date.now();
    while (Date.now() - start < 200) {}
    dedup.isDuplicate('om_new');
    assert.equal(dedup.size(), 1);
  });
});
