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

test('FeishuApi replyCard 回复消息失败时用 chatId 发送新卡片兜底', async () => {
  const api = new FeishuApi({ appId: 'cli_a', appSecret: 'sec' });
  api.token = 'tenant-token';
  api.tokenExpiresAt = Date.now() + 60000;
  const requests = [];
  api._request = async (method, host, path, body, token) => {
    requests.push({ method, host, path, body, token });
    if (requests.length === 1) {
      const err = new Error('feishu api http error: POST ' + path + ' status=400');
      err.method = method;
      err.path = path;
      err.status = 400;
      throw err;
    }
    return { code: 0, data: { message_id: 'om_fallback' } };
  };

  const messageId = await api.replyCard({ messageId: 'om_bad', chatId: 'oc_chat1' }, { elements: [] });

  assert.equal(messageId, 'om_fallback');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].path, '/open-apis/im/v1/messages/om_bad/reply');
  assert.equal(requests[1].path, '/open-apis/im/v1/messages?receive_id_type=chat_id');
  assert.equal(JSON.parse(requests[1].body).receive_id, 'oc_chat1');
  assert.equal(JSON.parse(requests[1].body).msg_type, 'interactive');
});

test('FeishuApi addReaction 捕获异步失败', async () => {
  const api = new FeishuApi({ appId: 'cli_a', appSecret: 'sec' });
  api.token = 'tenant-token';
  api.tokenExpiresAt = Date.now() + 60000;
  api._request = () => Promise.reject(new Error('reaction rejected'));

  await assert.doesNotReject(api.addReaction('om_1', 'DONE'));
});

test('FeishuApi addReaction 使用飞书要求的 emoji_type 字段', async () => {
  const api = new FeishuApi({ appId: 'cli_a', appSecret: 'sec' });
  api.token = 'tenant-token';
  api.tokenExpiresAt = Date.now() + 60000;
  let request;
  api._request = async (method, host, path, body, token) => {
    request = { method, host, path, body, token };
    return { code: 0 };
  };

  await api.addReaction('om_1', 'OnIt');

  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/open-apis/im/v1/messages/om_1/reactions');
  assert.deepEqual(JSON.parse(request.body), {
    reaction_type: { emoji_type: 'OnIt' },
  });
  assert.equal(Object.hasOwn(JSON.parse(request.body).reaction_type, 'emoji'), false);
});

test('FeishuApi sendText 将超长文本拆成多条消息完整发送', async () => {
  const api = new FeishuApi({ appId: 'cli_a', appSecret: 'sec' });
  api.token = 'tenant-token';
  api.tokenExpiresAt = Date.now() + 60000;
  const requests = [];
  api._request = async (method, host, path, body, token) => {
    requests.push({ method, host, path, body, token });
    return { code: 0, data: { message_id: 'om_' + requests.length } };
  };

  const text = 'a'.repeat(FeishuApi.MAX_TEXT_CHARS + 17);
  await api.sendText('oc_chat1', text);

  assert.equal(requests.length, 2);
  const sentText = requests
    .map((req) => JSON.parse(JSON.parse(req.body).content).text)
    .join('');
  assert.equal(sentText, text);
  assert.ok(JSON.parse(JSON.parse(requests[0].body).content).text.length <= FeishuApi.MAX_TEXT_CHARS);
  assert.ok(JSON.parse(JSON.parse(requests[1].body).content).text.length <= FeishuApi.MAX_TEXT_CHARS);
});

test('FeishuApi replyText 将超长回复拆成首条回复和后续群消息', async () => {
  const api = new FeishuApi({ appId: 'cli_a', appSecret: 'sec' });
  api.token = 'tenant-token';
  api.tokenExpiresAt = Date.now() + 60000;
  const requests = [];
  api._request = async (method, host, path, body, token) => {
    requests.push({ method, host, path, body, token });
    return { code: 0, data: { message_id: 'om_' + requests.length } };
  };

  const text = '行内容\n'.repeat(Math.ceil(FeishuApi.MAX_TEXT_CHARS / 4) + 2);
  await api.replyText({ messageId: 'om_parent', chatId: 'oc_chat1' }, text);

  assert.equal(requests.length > 1, true);
  assert.equal(requests[0].path, '/open-apis/im/v1/messages/om_parent/reply');
  assert.equal(requests[1].path, '/open-apis/im/v1/messages?receive_id_type=chat_id');
  const sentText = requests
    .map((req) => JSON.parse(JSON.parse(req.body).content).text)
    .join('');
  assert.equal(sentText, text);
});
