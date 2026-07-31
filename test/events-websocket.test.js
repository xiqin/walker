'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');

const { createAdminServer } = require('../src/admin/server');
const { createEventStore, recordEvent } = require('../src/admin/event-store');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withServer(testFn) {
  const eventStore = createEventStore();
  const adminServer = createAdminServer({
    config: { enabled: true, host: '127.0.0.1', port: 0, token: 'ws-token' },
    eventStore,
  });
  await adminServer.start();
  const port = adminServer.getStatus().port;
  try {
    await testFn({ adminServer, eventStore, port });
  } finally {
    await adminServer.stop();
  }
}

function adminLogin(port, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ token });
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/admin/auth/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error('login failed: ' + res.statusCode));
          return;
        }
        resolve((res.headers['set-cookie'] || [])[0] || '');
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function openWebSocket(port, token, extraHeaders) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, extraHeaders || {}, token ? { Authorization: 'Bearer ' + token } : {});
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events/stream`, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitForClose(ws, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for websocket close'));
    }, timeoutMs);
    function onClose(code) {
      cleanup();
      resolve(code);
    }
    function onError(err) {
      cleanup();
      reject(err);
    }
    function cleanup() {
      clearTimeout(timer);
      ws.off('close', onClose);
      ws.off('error', onError);
    }
    ws.on('close', onClose);
    ws.on('error', onError);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for websocket message'));
    }, timeoutMs);
    function onMessage(data) {
      const message = JSON.parse(data.toString('utf8'));
      if (!predicate || predicate(message)) {
        cleanup();
        resolve(message);
      }
    }
    function onError(err) {
      cleanup();
      reject(err);
    }
    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
    }
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

test('WS events 未认证连接被拒绝', async () => {
  await withServer(async ({ port, eventStore }) => {
    await assert.rejects(openWebSocket(port, ''), /Unexpected server response: 401/);
    assert.ok(eventStore.events.some((event) => event.type === 'ws.events.auth_failed'));
  });
});

test('WS events 拒绝带合法 cookie 的恶意 Origin 浏览器连接', async () => {
  await withServer(async ({ port, eventStore }) => {
    const cookie = await adminLogin(port, 'ws-token');
    await assert.rejects(
      openWebSocket(port, '', { Cookie: cookie, Origin: 'https://evil.example' }),
      /Unexpected server response: 403/,
    );
    assert.ok(eventStore.events.some((event) => event.type === 'ws.events.origin_rejected'));
    const raw = JSON.stringify(eventStore.events.filter((event) => event.type === 'ws.events.origin_rejected'));
    assert.doesNotMatch(raw, /walker_admin_sid|ws-token|Bearer/);
  });
});

test('WS events 允许无 Origin 的脚本客户端使用登录 cookie 连接', async () => {
  await withServer(async ({ port }) => {
    const cookie = await adminLogin(port, 'ws-token');
    const ws = await openWebSocket(port, '', { Cookie: cookie });
    try {
      assert.equal(ws.readyState, WebSocket.OPEN);
    } finally {
      ws.close();
    }
  });
});

test('WS events 认证成功后收到广播', async () => {
  await withServer(async ({ port, eventStore }) => {
    const ws = await openWebSocket(port, 'ws-token');
    try {
      const pending = waitForMessage(ws, (message) => message.type === 'event' && message.event.type === 'session.output');
      recordEvent(eventStore, { type: 'session.output', sessionId: 's1', routeKey: 'feishu:r1', message: 'hello' });
      const message = await pending;
      assert.equal(message.event.sessionId, 's1');
      assert.equal(message.event.routeKey, 'feishu:r1');
    } finally {
      ws.close();
    }
  });
});

test('WS events 复用同一 eventStore 时第二个 Admin server 也收到广播且 stop 后注销', async () => {
  const eventStore = createEventStore();
  const firstServer = createAdminServer({
    config: { enabled: true, host: '127.0.0.1', port: 0, token: 'ws-token' },
    eventStore,
  });
  const secondServer = createAdminServer({
    config: { enabled: true, host: '127.0.0.1', port: 0, token: 'ws-token' },
    eventStore,
  });

  await firstServer.start();
  await secondServer.start();
  const ws = await openWebSocket(secondServer.getStatus().port, 'ws-token');
  let firstBusEvents = 0;
  let secondBusEvents = 0;
  firstServer.eventBus.subscribe((event) => { if (event.type === 'store.reused.after.stop') firstBusEvents += 1; });
  secondServer.eventBus.subscribe((event) => { if (event.type === 'store.reused.after.stop') secondBusEvents += 1; });

  try {
    const pending = waitForMessage(ws, (message) => message.type === 'event' && message.event.type === 'store.reused');
    recordEvent(eventStore, { type: 'store.reused', message: 'second server receives' });
    const message = await pending;
    assert.equal(message.event.message, 'second server receives');

    ws.close();
    await wait(20);
    await secondServer.stop();
    recordEvent(eventStore, { type: 'store.reused.after.stop' });
    await wait(20);
    assert.equal(firstBusEvents, 1);
    assert.equal(secondBusEvents, 0);
  } finally {
    try { ws.close(); } catch (_) {}
    await secondServer.stop();
    await firstServer.stop();
  }
});

test('WS events 支持 sessionId routeKey level type 过滤', async () => {
  await withServer(async ({ port, eventStore }) => {
    const ws = await openWebSocket(port, 'ws-token');
    try {
      ws.send(JSON.stringify({ type: 'subscribe', filter: { sessionId: 's2', routeKey: 'feishu:r2', level: 'error', type: 'prompt.failed' } }));
      await waitForMessage(ws, (message) => message.type === 'subscribed');
      const pending = waitForMessage(ws, (message) => message.type === 'event' && message.event.type === 'prompt.failed');
      recordEvent(eventStore, { type: 'prompt.failed', level: 'error', sessionId: 's1', routeKey: 'feishu:r2', message: 'skip' });
      recordEvent(eventStore, { type: 'prompt.failed', level: 'error', sessionId: 's2', routeKey: 'feishu:r2', message: 'match' });
      const message = await pending;
      assert.equal(message.event.sessionId, 's2');
      assert.equal(message.event.message, 'match');
    } finally {
      ws.close();
    }
  });
});

test('WS events 拒绝超长 filter 并记录可观察错误', async () => {
  await withServer(async ({ port, eventStore }) => {
    const ws = await openWebSocket(port, 'ws-token');
    try {
      ws.send(JSON.stringify({ type: 'subscribe', filter: { sessionId: 'x'.repeat(300) } }));
      const message = await waitForMessage(ws, (item) => item.type === 'error');
      assert.equal(message.error.code, 'BAD_REQUEST');
      assert.ok(eventStore.events.some((event) => event.type === 'ws.events.invalid_message'));
    } finally {
      ws.close();
    }
  });
});

test('WS events 拒绝超大 payload 并释放订阅资源', async () => {
  await withServer(async ({ adminServer, port, eventStore }) => {
    const ws = await openWebSocket(port, 'ws-token');
    assert.equal(adminServer.wsEvents.getClientCount(), 1);
    assert.equal(adminServer.eventBus.getListenerCount(), 1);

    const closePending = waitForClose(ws);
    ws.send(JSON.stringify({
      type: 'subscribe',
      filter: { sessionId: 'x'.repeat(70 * 1024) },
    }));

    const code = await closePending;
    await wait(50);

    assert.ok([1008, 1009, 1006].includes(code));
    assert.equal(adminServer.wsEvents.getClientCount(), 0);
    assert.equal(adminServer.eventBus.getListenerCount(), 0);
    assert.ok(eventStore.events.some((event) => event.type === 'ws.events.error' || event.type === 'ws.events.invalid_message'));
    const raw = JSON.stringify(eventStore.events);
    assert.doesNotMatch(raw, /Cookie|Authorization|walker_admin_sid|ws-token|Bearer/);
  });
});

test('WS events 连续非法 JSON 或不支持类型达到阈值后关闭连接', async () => {
  await withServer(async ({ port, eventStore }) => {
    const ws = await openWebSocket(port, 'ws-token');
    const closePending = waitForClose(ws);
    ws.send('{bad json');
    await waitForMessage(ws, (item) => item.type === 'error');
    ws.send(JSON.stringify({ type: 'unknown' }));
    await waitForMessage(ws, (item) => item.type === 'error');
    ws.send('{bad json again');
    const code = await closePending;
    assert.equal(code, 1008);
    assert.ok(eventStore.events.some((event) => event.type === 'ws.events.closed' && event.data.reason === 'too_many_bad_messages'));
  });
});

test('WS events 广播前脱敏敏感字段', async () => {
  await withServer(async ({ port, eventStore }) => {
    const ws = await openWebSocket(port, 'ws-token');
    try {
      const pending = waitForMessage(ws, (message) => message.type === 'event' && message.event.type === 'secret.test');
      recordEvent(eventStore, { type: 'secret.test', data: { token: 'plain-token', nested: { FEISHU_APP_SECRET: 'plain-secret' }, text: 'Bearer plain-token' } });
      const message = await pending;
      const raw = JSON.stringify(message);
      assert.doesNotMatch(raw, /plain-token|plain-secret/);
      assert.equal(message.event.data.token, '[redacted]');
      assert.equal(message.event.data.nested.FEISHU_APP_SECRET, '[redacted]');
    } finally {
      ws.close();
    }
  });
});

test('WS events 断开后释放订阅资源', async () => {
  await withServer(async ({ adminServer, port, eventStore }) => {
    const ws = await openWebSocket(port, 'ws-token');
    assert.equal(adminServer.eventBus.getListenerCount(), 1);
    ws.close();
    await wait(50);
    assert.equal(adminServer.eventBus.getListenerCount(), 0);
    recordEvent(eventStore, { type: 'after.close' });
    assert.ok(eventStore.events.some((event) => event.type === 'ws.events.disconnected'));
  });
});

test('WS events adminServer.stop 主动关闭客户端并释放订阅', async () => {
  const eventStore = createEventStore();
  const adminServer = createAdminServer({
    config: { enabled: true, host: '127.0.0.1', port: 0, token: 'ws-token' },
    eventStore,
  });
  await adminServer.start();
  const ws = await openWebSocket(adminServer.getStatus().port, 'ws-token');
  try {
    assert.equal(adminServer.wsEvents.getClientCount(), 1);
    assert.equal(adminServer.eventBus.getListenerCount(), 1);
    const closePending = waitForClose(ws);
    await adminServer.stop();
    await closePending;
    assert.equal(adminServer.wsEvents.getClientCount(), 0);
    assert.equal(adminServer.eventBus.getListenerCount(), 0);
    assert.ok(eventStore.events.some((event) => event.type === 'ws.events.disconnected' && event.data.reason === 'server_close'));
  } finally {
    try { ws.close(); } catch (_) {}
    await adminServer.stop();
  }
});

test('WS events send 失败和错误可观察且不退出主流程', async () => {
  await withServer(async ({ adminServer, eventStore }) => {
    const fakeClient = {
      readyState: WebSocket.OPEN,
      send(_payload, callback) { callback(new Error('send failed')); },
      on() {},
      ping() {},
      terminate() {},
    };
    adminServer.wsEvents.getServer().emit('connection', fakeClient, { socket: { remoteAddress: '127.0.0.1' } });
    recordEvent(eventStore, { type: 'send.failure.visible', message: 'trigger' });
    await wait(20);
    assert.ok(eventStore.events.some((event) => event.type === 'ws.events.send_failed'));
    assert.ok(eventStore.events.some((event) => event.type === 'ws.events.disconnected' && event.data.reason === 'send_failed'));
  });
});
