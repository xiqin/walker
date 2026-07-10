const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { FeishuApi } = require('../src/platform/feishu/api');

function withMockHttps(responses, fn) {
  const originalRequest = https.request;
  https.request = (options, callback) => {
    const response = responses.shift();
    assert.ok(response, 'missing mock response for ' + options.method + ' ' + options.path);
    const req = new EventEmitter();
    req.write = (body) => { req.body = body; };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = response.statusCode;
      process.nextTick(() => {
        callback(res);
        res.emit('data', JSON.stringify(response.body));
        res.emit('end');
      });
    };
    return req;
  };

  return Promise.resolve()
    .then(fn)
    .finally(() => { https.request = originalRequest; });
}

test('FeishuApi _request 遇到 HTTP 错误时带上下文失败', async () => {
  await withMockHttps([
    { statusCode: 500, body: { code: 0, msg: 'server failed' } },
  ], async () => {
    const api = new FeishuApi({ appId: 'cli_a', appSecret: 'sec' });
    await assert.rejects(
      api._request('POST', 'open.feishu.cn', '/open-apis/test', '{}'),
      (err) => {
        assert.equal(err.method, 'POST');
        assert.equal(err.path, '/open-apis/test');
        assert.equal(err.status, 500);
        return true;
      },
    );
  });
});

test('FeishuApi _request 遇到飞书业务 code 非 0 时带上下文失败', async () => {
  await withMockHttps([
    { statusCode: 200, body: { code: 99991663, msg: 'bad token' } },
  ], async () => {
    const api = new FeishuApi({ appId: 'cli_a', appSecret: 'sec' });
    await assert.rejects(
      api._request('PATCH', 'open.feishu.cn', '/open-apis/im/v1/messages/om_1', '{}'),
      (err) => {
        assert.equal(err.method, 'PATCH');
        assert.equal(err.path, '/open-apis/im/v1/messages/om_1');
        assert.equal(err.status, 200);
        assert.equal(err.code, 99991663);
        return true;
      },
    );
  });
});

test('FeishuApi replyCard 缺少真实 message_id 时失败', async () => {
  await withMockHttps([
    { statusCode: 200, body: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 } },
    { statusCode: 200, body: { code: 0, data: {} } },
  ], async () => {
    const api = new FeishuApi({ appId: 'cli_a', appSecret: 'sec' });
    await assert.rejects(
      api.replyCard({ messageId: 'om_parent' }, { elements: [] }),
      /message_id/,
    );
  });
});

test('FeishuApi addReaction 捕获异步失败', async () => {
  const api = new FeishuApi({ appId: 'cli_a', appSecret: 'sec' });
  api.token = 'tenant-token';
  api.tokenExpiresAt = Date.now() + 60000;
  api._request = () => Promise.reject(new Error('reaction rejected'));

  await assert.doesNotReject(api.addReaction('om_1', 'DONE'));
});
