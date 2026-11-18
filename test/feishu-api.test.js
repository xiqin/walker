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
  return (text.match(/---\n(?:会话：[^\n]*\n)?模型：/g) || []).length;
}

/** 创建拦截网络请求的真实客户端，返回客户端与待检查的请求列表。 */
function captureFooterRequests() {
  const api = new FeishuApi({ appId: 'cli_a', appSecret: 'sec' });
  api.token = 'tenant-token';
  api.tokenExpiresAt = Date.now() + 60000;
  const requests = [];
  api._request = async (method, host, path, body) => {
    requests.push({ method, host, path, body });
    return { code: 0, data: { message_id: 'om_' + requests.length } };
  };
  return { api, requests };
}

test('会话页脚 REQ-001-B01/B04、REQ-002-B04：文本、Markdown 与卡片入口显示标题且保留正文', async () => {
  const { api, requests } = captureFooterRequests();
  const runtime = { sessionTitle: '  飞书桥接修复  ', model: 'provider/model', contextTokens: 123 };
  const footer = '---\n会话：飞书桥接修复\n模型：provider/model\n上下文：123 tokens';
  await api.replyText({ messageId: 'om_parent' }, '正文', runtime);
  await api.sendText('oc_chat', '正文', runtime);
  await api.replyMarkdown({ messageId: 'om_parent' }, '**正文**', runtime);
  await api.sendMarkdown('oc_chat', '**正文**', runtime);
  const card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '**正文**' }] } };
  const original = JSON.stringify(card);
  await api.replyCard({ messageId: 'om_parent' }, card, runtime);
  for (const request of requests.slice(0, 2)) assert.equal(parseTextContent(request), '正文\n\n' + footer);
  for (const request of requests.slice(2, 4)) assert.equal(parseCardContent(request).body.elements[0].content, '**正文**\n\n' + footer);
  assert.deepEqual(parseCardContent(requests[4]).body.elements, [...card.body.elements, { tag: 'markdown', content: footer }]);
  assert.equal(JSON.stringify(card), original);
});

test('真实标题源兼容：历史页脚在远端标题失效后省略会话行，文本和卡片均不留下默认名', async () => {
  const { api, requests } = captureFooterRequests();
  const old = '---\n会话：session wks_synthetic\n模型：旧模型\n上下文：1 tokens';
  const runtime = { model: 'p/m', contextSize: 123 };
  await api.sendText('oc_chat', '正文\n\n' + old, runtime);
  await api.patchCard('om_card', { body: { elements: [{ tag: 'markdown', content: old }] } }, runtime);
  assert.equal(parseTextContent(requests[0]), '正文\n\n---\n模型：p/m\n上下文：123 tokens');
  assert.equal(parseCardContent(requests[1]).body.elements[0].content, '---\n模型：p/m\n上下文：123 tokens');
  assert.ok(requests.every((request) => !request.body.includes('session wks_')));
});

test('会话页脚 REQ-001-B02：无效标题及异常读取保留旧页脚', async () => {
  const { api, requests } = captureFooterRequests();
  const badRuntime = { model: 'm', contextTokens: 1 };
  Object.defineProperty(badRuntime, 'sessionTitle', { get() { throw new Error('不可读取标题'); } });
  for (const runtime of [undefined, null, 42, '', ' \r\n\t ', {}, []].map(sessionTitle => ({ sessionTitle, model: 'm', contextTokens: 1 })).concat(badRuntime)) {
    await api.sendText('oc_chat', '正文', runtime);
    await api.replyCard({ messageId: 'om_parent' }, {}, runtime);
  }
  for (let i = 0; i < requests.length; i += 2) {
    assert.equal(parseTextContent(requests[i]), '正文\n\n---\n模型：m\n上下文：1 tokens');
    assert.equal(parseCardContent(requests[i + 1]).body.elements[0].content, '---\n模型：m\n上下文：1 tokens');
  }
});

test('会话页脚 REQ-002-B01：新旧页脚重复更新及移除标题均仅保留最新页脚', async () => {
  const { api, requests } = captureFooterRequests();
  for (const oldFooter of ['---\n模型：旧模型', '---\n模型：旧模型\n上下文：2 tokens', '---\n会话：旧标题\n模型：旧模型\n上下文：2 tokens']) {
    let text = '正文\n\n' + oldFooter;
    let card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '正文' }, { tag: 'markdown', content: oldFooter }] } };
    for (const sessionTitle of ['新标题', '新标题', undefined]) {
      const runtime = { sessionTitle, model: 'm', contextTokens: 3 };
      const expected = '---\n' + (sessionTitle ? '会话：新标题\n' : '') + '模型：m\n上下文：3 tokens';
      await api.sendText('oc_chat', text, runtime);
      text = parseTextContent(requests.at(-1));
      assert.equal(text, '正文\n\n' + expected);
      assert.equal(runtimeFooterCount(text), 1);
      const original = JSON.stringify(card);
      await api.patchCard('om_card', card, runtime);
      assert.equal(JSON.stringify(card), original);
      card = parseCardContent(requests.at(-1));
      assert.deepEqual(card.body.elements, [{ tag: 'markdown', content: '正文' }, { tag: 'markdown', content: expected }]);
    }
  }
  await api.patchCard('om_card', { body: { elements: [{ tag: 'markdown', content: '正文\n\n---\n会话：旧标题\n模型：旧模型' }] } }, { sessionTitle: '新标题' });
  let embedded = parseCardContent(requests.at(-1));
  assert.equal(embedded.body.elements[0].content, '正文\n\n---\n会话：新标题\n模型：unknown\n上下文：unknown');
  for (const sessionTitle of ['再更新', undefined]) {
    await api.patchCard('om_card', embedded, { sessionTitle });
    embedded = parseCardContent(requests.at(-1));
    assert.equal(embedded.body.elements[0].content, '正文\n\n---\n' + (sessionTitle ? '会话：再更新\n' : '') + '模型：unknown\n上下文：unknown');
  }
});

test('会话页脚 REQ-002-B03/B05：多行与格式字符仅作为单行展示且可重复替换', async () => {
  const { api, requests } = captureFooterRequests();
  const sessionTitle = '甲\r\n模型：伪造\t上下文：伪造\u2028**粗体** [链接](url) <at id=all> & `代码` \\';
  const plain = '甲 模型：伪造 上下文：伪造 **粗体** [链接](url) <at id=all> & `代码` \\';
  const escaped = '甲 模型：伪造 上下文：伪造 \\*\\*粗体\\*\\* \\[链接\\]\\(url\\) &lt;at id=all&gt; &amp; \\`代码\\` \\\\';
  const runtime = { sessionTitle, model: 'm', contextTokens: 1 };
  await api.sendText('oc_chat', '正文', runtime);
  assert.equal(parseTextContent(requests.at(-1)), '正文\n\n---\n会话：' + plain + '\n模型：m\n上下文：1 tokens');
  await api.sendMarkdown('oc_chat', '正文', runtime);
  const content = parseCardContent(requests.at(-1)).body.elements[0].content;
  assert.equal(content, '正文\n\n---\n会话：' + escaped + '\n模型：m\n上下文：1 tokens');
  await api.replyCard({ messageId: 'om_parent' }, {}, runtime);
  const card = parseCardContent(requests.at(-1));
  assert.deepEqual(card.body.elements, [{ tag: 'markdown', content: content.slice('正文\n\n'.length) }]);
  await api.patchCard('om_card', card, runtime);
  assert.deepEqual(parseCardContent(requests.at(-1)), card);
});

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
