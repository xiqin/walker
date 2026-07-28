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

function parseBody(request) {
  return JSON.parse(request.body);
}

function parseTextContent(request) {
  return JSON.parse(parseBody(request).content).text;
}

function parseCardContent(request) {
  return JSON.parse(parseBody(request).content);
}

function runtimeFooterCount(text) {
  return (text.match(/---\n模型：/g) || []).length;
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
    .map(parseTextContent)
    .join('');
  assert.equal(sentText, FeishuApi.appendRuntimeFooter(text));
  assert.ok(parseTextContent(requests[0]).length <= FeishuApi.MAX_TEXT_CHARS);
  assert.ok(parseTextContent(requests[1]).length <= FeishuApi.MAX_TEXT_CHARS);
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
    .map(parseTextContent)
    .join('');
  assert.equal(sentText, FeishuApi.appendRuntimeFooter(text));
});

test('FeishuApi 文本和 Markdown 消息统一追加模型与上下文页脚', async () => {
  const api = new FeishuApi({ appId: 'cli_a', appSecret: 'sec' });
  api.token = 'tenant-token';
  api.tokenExpiresAt = Date.now() + 60000;
  const requests = [];
  api._request = async (method, host, path, body, token) => {
    requests.push({ method, host, path, body, token });
    return { code: 0, data: { message_id: 'om_' + requests.length } };
  };

  const runtime = { model: { providerID: 'anthropic', modelID: 'claude-sonnet' }, contextTokens: 1234 };
  await api.replyText({ messageId: 'om_parent', chatId: 'oc_chat1' }, '正文', runtime);
  await api.sendText('oc_chat1', '广播', { model: 'openai/gpt-4.1', contextSize: '8 KB' });
  await api.replyMarkdown({ messageId: 'om_parent' }, '**回答**', runtime);
  await api.sendMarkdown('oc_chat1', '**通知**', runtime);

  assert.equal(parseTextContent(requests[0]), '正文\n\n---\n模型：anthropic/claude-sonnet\n上下文：1234 tokens');
  assert.equal(parseTextContent(requests[1]), '广播\n\n---\n模型：openai/gpt-4.1\n上下文：8 KB');
  assert.equal(parseCardContent(requests[2]).body.elements[0].content, '**回答**\n\n---\n模型：anthropic/claude-sonnet\n上下文：1234 tokens');
  assert.equal(parseCardContent(requests[3]).body.elements[0].content, '**通知**\n\n---\n模型：anthropic/claude-sonnet\n上下文：1234 tokens');
});

test('FeishuApi 页脚幂等追加并在缺失或异常输入时展示 unknown', async () => {
  const api = new FeishuApi({ appId: 'cli_a', appSecret: 'sec' });
  api.token = 'tenant-token';
  api.tokenExpiresAt = Date.now() + 60000;
  const requests = [];
  api._request = async (method, host, path, body, token) => {
    requests.push({ method, host, path, body, token });
    return { code: 0, data: { message_id: 'om_' + requests.length } };
  };
  const badRuntime = {};
  Object.defineProperty(badRuntime, 'model', { get() { throw new Error('bad model'); } });
  Object.defineProperty(badRuntime, 'contextSize', { get() { throw new Error('bad context'); } });
  const existing = '正文\n\n---\n模型：old\n上下文：10 tokens';

  await api.sendText('oc_chat1', existing, badRuntime);

  const text = parseTextContent(requests[0]);
  assert.equal(runtimeFooterCount(text), 1);
  assert.equal(text, '正文\n\n---\n模型：unknown\n上下文：unknown');
  assert.equal(text.includes('undefined'), false);
  assert.equal(text.includes('[object Object]'), false);
});

test('FeishuApi replyCard 和 patchCard 在 body.elements 末尾幂等追加运行信息', async () => {
  const api = new FeishuApi({ appId: 'cli_a', appSecret: 'sec' });
  api.token = 'tenant-token';
  api.tokenExpiresAt = Date.now() + 60000;
  const requests = [];
  api._request = async (method, host, path, body, token) => {
    requests.push({ method, host, path, body, token });
    return { code: 0, data: { message_id: 'om_' + requests.length } };
  };

  const card = { schema: '2.0', header: { title: { tag: 'plain_text', content: '标题' } }, body: { elements: [{ tag: 'markdown', content: '原卡片' }] } };
  await api.replyCard({ messageId: 'om_parent' }, card, { defaultModel: 'qwen/default', tokenUsage: { totalTokens: 77 } });
  await api.patchCard('om_card', parseCardContent(requests[0]), { model: 'ignored', contextTokens: 88 });

  const replyCard = parseCardContent(requests[0]);
  const patchCard = JSON.parse(parseBody(requests[1]).content);
  assert.equal(replyCard.header.title.content, '标题');
  assert.equal(replyCard.body.elements[0].content, '原卡片');
  assert.equal(replyCard.body.elements.at(-1).content, '---\n模型：qwen/default\n上下文：77 tokens');
  assert.equal(patchCard.body.elements.filter((element) => element.tag === 'markdown' && element.content.includes('模型：')).length, 1);
  assert.equal(patchCard.body.elements.at(-1).content, '---\n模型：ignored\n上下文：88 tokens');
});
