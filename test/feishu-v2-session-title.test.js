'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { getPluginSource } = require('../src/opencode-hook/plugin-template');
const { OpencodeTuiBridge } = require('../src/opencode-tui-bridge/bridge');
const { OpencodeDriver } = require('../src/drivers/opencode-driver');
const { SessionService } = require('../src/core/session-service');
const { JsonStore } = require('../src/core/json-store');
const { MessageDispatcher } = require('../src/dispatch/message-dispatcher');
const { MessageDedup } = require('../src/core/message-dedup');
const { FeishuApi } = require('../src/platform/feishu/api');

/** 有明确截止时间的条件等待，不依赖固定业务延时。 */
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, '未观察到预期发送边界');
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** 插件服务缓存→桥接入口动作→驱动→调度→实际飞书请求体；不覆盖HTTP认证中间件。 */
function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-v2-title-chain-'));
  const sessions = new SessionService({ stateStore: new JsonStore(path.join(directory, 'state.json'), {}) });
  const bridge = new OpencodeTuiBridge({ sessionService: sessions });
  let sqliteReads = 0;
  let httpReads = 0;
  const driver = new OpencodeDriver({ tuiBridge: bridge, serverUrl: 'http://127.0.0.1:1', autostart: false,
    readServiceRecord: () => null, modelState: {}, opencodeDbPath: path.join(directory, 'legacy.db'),
    execFile: async () => { sqliteReads++; return { stdout: '' }; },
    httpClient: { request: async () => { httpReads++; throw new Error('不得查询默认服务'); } } });
  const requests = [];
  const api = new FeishuApi({ appId: '合成应用', appSecret: '合成密钥' });
  api.token = '合成token';
  api.tokenExpiresAt = Date.now() + 600000;
  api._request = async (_method, _host, _url, body) => {
    requests.push(JSON.parse(JSON.parse(body).content));
    return { code: 0, data: { message_id: 'om_synthetic_' + requests.length } };
  };
  const dispatcher = new MessageDispatcher({ sessionService: sessions, driverRegistry: { get: () => driver },
    feishuApi: api, dedup: new MessageDedup({ windowMs: 300000 }) });
  const originalFetch = global.fetch;
  const wire = [];
  const disposers = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    wire.push({ url: String(url), body });
    let data = {};
    if (String(url).endsWith('/register')) data = bridge.register(body);
    else if (String(url).endsWith('/events')) data = bridge.reportEvents(body);
    else if (String(url).endsWith('/poll')) data = { delivery: bridge.poll(body) };
    else if (String(url).endsWith('/dispose')) bridge.dispose(body);
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };
  t.after(async () => {
    for (const dispose of disposers) await dispose();
    global.fetch = originalFetch;
    dispatcher.destroy();
    bridge.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  /** 每个插件使用独立服务缓存，即使同会话ID也不能借另一runtime的数据。 */
  async function plugin(id, read) {
    const handlers = new Map();
    const reads = [];
    const cache = { id, title: '初始真实标题' };
    const source = getPluginSource(8787, '合成桥接口令');
    const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#' + disposers.length);
    const dispose = await module.default.setup({ app: { version: '2.1.1' }, location: { directory },
      ui: { router: { current: () => ({ type: 'session', sessionID: id }) } },
      data: { on(type, handler) { handlers.set(type, handler); return () => handlers.delete(type); },
        session: { get(requested) { reads.push(requested); return read ? read(requested) : cache; },
          status: () => 'idle', message: { list: () => [] } } } });
    disposers.push(dispose);
    await until(() => wire.filter(request => request.url.endsWith('/register')).length === disposers.length);
    const registration = wire.filter(request => request.url.endsWith('/register')).at(-1);
    const runtime = bridge.runtimes.get(registration.body.runtimeId);
    const session = sessions.getSession(runtime.walkerSessionId);
    sessions.addSessionToRoute('feishu:oc_titles', session.id, directory);
    sessions.updateSessionField(session.id, 'model', { providerID: 'p', modelID: 'm' });
    dispatcher.ensureWatchForSession(session.id);
    return { cache, reads, session, registration,
      async finish(text, messageId) {
        await handlers.get('session.execution.started')({ data: { sessionID: id } });
        await handlers.get('session.text.ended')({ data: { sessionID: id, assistantMessageID: messageId, ordinal: 0, text } });
        await handlers.get('session.step.ended')({ data: { sessionID: id, assistantMessageID: messageId,
          tokens: { input: 123, output: 0, total: 123 } } });
        await handlers.get('session.execution.succeeded')({ data: { sessionID: id } });
      } };
  }
  return { plugin, requests, wire, sessions, driver, bridge,
    assertNoOtherSource() { assert.equal(sqliteReads, 0); assert.equal(httpReads, 0); } };
}

test('V2插件服务标题经注册和完成事件进入非焦点飞书页脚，同ID不同runtime不串标题', async t => {
  const h = harness(t);
  const a = await h.plugin('ses_same');
  const b = await h.plugin('ses_same');
  a.cache.title = '服务甲的真实标题';
  b.cache.title = '服务乙的真实标题';
  h.sessions.setFocus('feishu:oc_titles', b.session.id);
  await a.finish('甲的完成正文', 'msg_title_a');
  await b.finish('乙的完成正文', 'msg_title_b');
  await until(() => h.requests.filter(body => JSON.stringify(body).includes('完成正文')).length === 2);
  const outputs = h.requests.filter(body => JSON.stringify(body).includes('完成正文'));
  const aBody = JSON.stringify(outputs.find(body => JSON.stringify(body).includes('甲的完成正文')));
  const bBody = JSON.stringify(outputs.find(body => JSON.stringify(body).includes('乙的完成正文')));
  assert.ok(aBody.includes('会话：服务甲的真实标题') && !aBody.includes('服务乙的真实标题'));
  assert.ok(bBody.includes('会话：服务乙的真实标题') && !bBody.includes('服务甲的真实标题'));
  assert.ok(aBody.includes('[session: '), '保留非焦点正文区分标记');
  for (const body of [aBody, bBody]) {
    assert.ok(body.includes('模型：p/m'));
    assert.ok(body.includes('上下文：123 tokens'));
  }
  assert.ok(a.reads.length >= 2 && a.reads.every(id => id === 'ses_same'));
  h.assertNoOtherSource();
});

for (const kind of ['错配ID', '读取异常', '空标题']) {
  test('V2插件' + kind + '时正常发送正文但不借用焦点、默认服务或SQLite标题', async t => {
    const h = harness(t);
    const owner = await h.plugin('ses_owned', () => {
      if (kind === '读取异常') throw new Error('合成读取异常');
      return kind === '错配ID' ? { id: 'ses_wrong', title: '不可泄漏的其他标题' } : { id: 'ses_owned', title: '' };
    });
    await owner.finish('缺标题仍发送正文', 'msg_missing');
    await until(() => h.requests.some(body => JSON.stringify(body).includes('缺标题仍发送正文')));
    const output = JSON.stringify(h.requests.find(body => JSON.stringify(body).includes('缺标题仍发送正文')));
    assert.ok(!output.includes('会话：') && !output.includes('不可泄漏的其他标题'));
    assert.ok(output.includes('模型：p/m') && output.includes('上下文：123 tokens'));
    h.assertNoOtherSource();
  });
}
