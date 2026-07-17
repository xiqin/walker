const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { AttachmentService } = require('../src/dispatch/attachment-service');

describe('AttachmentService inbound', () => {
  it('保存文件到 session attachments 目录并返回路径', () => {
    const svc = new AttachmentService({ dataDir: 'C:\\tmp\\.walker' });
    const filePath = svc.getInboundPath('wks_session1', 'report.pdf');
    assert.ok(filePath.includes('wks_session1'));
    assert.ok(filePath.includes('attachments'));
    assert.ok(filePath.endsWith('report.pdf'));
  });

  it('危险文件名被安全化', () => {
    const svc = new AttachmentService({ dataDir: 'C:\\tmp\\.walker' });
    const filePath = svc.getInboundPath('wks_session1', '../../../etc/passwd');
    assert.ok(!filePath.includes('..'));
    assert.ok(filePath.includes('wks_session1'));
    assert.ok(filePath.endsWith('.passwd') || filePath.endsWith('passwd.bin'));
  });

  it('扩展名缺失时用 .bin', () => {
    const svc = new AttachmentService({ dataDir: 'C:\\tmp\\.walker' });
    const filePath = svc.getInboundPath('wks_session1', 'noext');
    assert.ok(filePath.endsWith('.bin'));
  });
});

describe('AttachmentService outbound', () => {
  it('outbound 接口签名正确', () => {
    const svc = new AttachmentService({ dataDir: 'C:\\tmp\\.walker' });
    assert.equal(typeof svc.sendOutbound, 'function');
  });
});
