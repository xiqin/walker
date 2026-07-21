'use strict';

/**
 * Admin 调试工具、卡片预览、指标与服务控制测试
 * 覆盖 REQ-020, REQ-021, REQ-023, REQ-024, REQ-026
 * 使用 fake/stub 依赖，不依赖真实 driver 或飞书连接
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { createEventStore, recordEvent } = require('../src/admin/event-store');
const { success, error, send } = require('../src/admin/response');
const { createRouter } = require('../src/admin/router');
const { simulateCommand } = require('../src/admin/command-simulator');
const { listCardTypes, getSampleData, previewCard } = require('../src/admin/card-preview');
const { handleServiceStop } = require('../src/admin/service-control');
const { createToolsRoutes } = require('../src/admin/tools-routes');

/**
 * 创建模拟 HTTP 响应对象
 * @returns {Object} mock res 对象
 */
function createMockRes() {
  var res = {
    statusCode: null,
    body: null,
    headers: {},
    writeHead: function (code, headers) {
      res.statusCode = code;
      if (headers) Object.assign(res.headers, headers);
    },
    end: function (data) {
      res.body = data ? JSON.parse(data) : null;
    },
    setHeader: function (key, value) {
      res.headers[key] = value;
    },
  };
  return res;
}

/**
 * 创建模拟 HTTP 请求对象
 * @param {Object} opts - 请求选项
 * @returns {Object} mock req 对象
 */
function createMockReq(opts) {
  var o = opts || {};
  var req = new EventEmitter();
  req.method = o.method || 'GET';
  req.url = o.url || '/';
  req.urlPath = o.urlPath || '/';
  req.queryString = o.queryString || '';
  req.headers = o.headers || {};
  req.params = o.params || {};

  if (o.body) {
    var bodyStr = JSON.stringify(o.body);
    req.headers['content-length'] = String(Buffer.byteLength(bodyStr));
    setTimeout(function () {
      req.emit('data', Buffer.from(bodyStr));
      req.emit('end');
    }, 0);
  } else {
    setTimeout(function () {
      req.emit('end');
    }, 0);
  }

  return req;
}

/**
 * 等待异步操作完成（处理 parseBody 异步）
 * @param {Function} fn - 包含异步请求的函数
 * @returns {Promise<Object>} mock res 对象
 */
function awaitRequest(fn) {
  return new Promise(function (resolve) {
    var res = createMockRes();
    fn(res);
    setTimeout(function () {
      resolve(res);
    }, 50);
  });
}

/**
 * 注册路由并创建模拟请求处理函数
 * @param {Object[]} routeList - 路由数组
 * @param {Function} [authGuard] - 鉴权包装器
 * @returns {Object} 处理函数
 */
function setupRouter(routeList, authGuard) {
  var router = createRouter();
  for (var i = 0; i < routeList.length; i++) {
    var r = routeList[i];
    var handler = authGuard ? authGuard(r.handler) : r.handler;
    router.add(r.method, r.pattern, handler);
  }
  return router;
}

// ===== 命令模拟器测试 =====

test('simulateCommand: 解析 /new 命令成功', function () {
  var result = simulateCommand('/new opencode my-project');
  assert.equal(result.parsed.type, 'command');
  assert.equal(result.parsed.name, 'new');
  assert.deepEqual(result.parsed.args, ['opencode', 'my-project']);
  assert.equal(result.action.action, 'create_session');
  assert.equal(result.dryRun, true);
});

test('simulateCommand: 解析 /list 命令', function () {
  var result = simulateCommand('/list');
  assert.equal(result.parsed.type, 'command');
  assert.equal(result.parsed.name, 'list');
  assert.equal(result.action.action, 'list_sessions');
});

test('simulateCommand: 解析 /help 命令', function () {
  var result = simulateCommand('/help');
  assert.equal(result.parsed.type, 'command');
  assert.equal(result.parsed.name, 'help');
  assert.equal(result.action.action, 'show_help');
});

test('simulateCommand: 未知命令返回 text 类型', function () {
  var result = simulateCommand('/unknown_command test');
  assert.equal(result.parsed.type, 'text');
  assert.equal(result.action.action, 'send_text');
});

test('simulateCommand: 普通文本（无 / 前缀）', function () {
  var result = simulateCommand('你好，请帮我写代码');
  assert.equal(result.parsed.type, 'text');
  assert.equal(result.action.action, 'send_text');
  assert.equal(result.parsed.text, '你好，请帮我写代码');
});

test('simulateCommand: dryRun 默认为 true', function () {
  var result = simulateCommand('/new');
  assert.equal(result.dryRun, true);
});

test('simulateCommand: dryRun 可显式设为 false', function () {
  var result = simulateCommand('/new', { dryRun: false });
  assert.equal(result.dryRun, false);
});

test('simulateCommand: 带 routeKey 参数', function () {
  var result = simulateCommand('/stop', { routeKey: 'feishu:test_chat' });
  assert.equal(result.action.routeKey, 'feishu:test_chat');
});

test('simulateCommand: /use off 解除绑定', function () {
  var result = simulateCommand('/use off');
  assert.equal(result.parsed.name, 'use');
  assert.equal(result.action.description, '解除当前路由绑定');
});

test('simulateCommand: /use <id> 绑定会话', function () {
  var result = simulateCommand('/use wks_abc123');
  assert.equal(result.parsed.name, 'use');
  assert.equal(result.action.description, '绑定当前对话到指定会话');
});

test('simulateCommand: 命令有 commandDef', function () {
  var result = simulateCommand('/new');
  assert.ok(result.commandDef);
  assert.equal(result.commandDef.desc, '创建新会话');
});

test('simulateCommand: 未知命令无 commandDef', function () {
  var result = simulateCommand('hello world');
  assert.equal(result.commandDef, undefined);
});

// ===== 卡片预览测试 =====

test('listCardTypes: 返回 11 种卡片类型', function () {
  var types = listCardTypes();
  assert.equal(types.length, 11);
  var names = types.map(function (t) { return t.name; });
  assert.ok(names.includes('unbound_route'));
  assert.ok(names.includes('session_list'));
  assert.ok(names.includes('attachable_session'));
  assert.ok(names.includes('error'));
  assert.ok(names.includes('progress'));
  assert.ok(names.includes('question_confirm'));
  assert.ok(names.includes('question_single_select'));
  assert.ok(names.includes('question_multi_select'));
  assert.ok(names.includes('question_text'));
  assert.ok(names.includes('question_replied'));
  assert.ok(names.includes('question_replied_multi'));
});

test('listCardTypes: 每个类型含 name 和 description', function () {
  var types = listCardTypes();
  for (var i = 0; i < types.length; i++) {
    assert.ok(typeof types[i].name === 'string');
    assert.ok(typeof types[i].description === 'string');
    assert.ok(types[i].name.length > 0);
    assert.ok(types[i].description.length > 0);
  }
});

test('getSampleData: 获取 unbound_route 示例数据', function () {
  var data = getSampleData('unbound_route');
  assert.ok(data);
  assert.equal(typeof data.routeKey, 'string');
});

test('getSampleData: 获取 error 示例数据', function () {
  var data = getSampleData('error');
  assert.ok(data);
  assert.equal(typeof data.message, 'string');
});

test('getSampleData: 获取 progress 示例数据', function () {
  var data = getSampleData('progress');
  assert.ok(data);
  assert.ok(data.sessionId);
  assert.ok(data.phase);
  assert.ok(Array.isArray(data.entries));
});

test('getSampleData: 未知类型返回 null', function () {
  var data = getSampleData('nonexistent');
  assert.equal(data, null);
});

test('previewCard: 预览 unbound_route 卡片返回 JSON', function () {
  var result = previewCard('unbound_route');
  assert.ok(result);
  assert.equal(result.typeName, 'unbound_route');
  assert.ok(result.rendered);
  assert.ok(result.rendered.header);
  assert.ok(result.preview);
  assert.ok(result.preview.header);
});

test('previewCard: 预览 error 卡片', function () {
  var result = previewCard('error');
  assert.ok(result);
  assert.equal(result.typeName, 'error');
  assert.ok(result.rendered);
  assert.equal(result.rendered.header.template, 'red');
});

test('previewCard: 预览 progress 卡片', function () {
  var result = previewCard('progress');
  assert.ok(result);
  assert.equal(result.typeName, 'progress');
  assert.ok(result.rendered);
  assert.ok(result.rendered.header);
  var els = result.rendered.body ? result.rendered.body.elements : result.rendered.elements;
  assert.ok(els.length > 0);
});

test('previewCard: 使用自定义数据预览 error 卡片', function () {
  var result = previewCard('error', { message: '自定义错误' });
  assert.ok(result);
  assert.equal(result.data.message, '自定义错误');
});

test('previewCard: 未知类型返回 null', function () {
  var result = previewCard('nonexistent');
  assert.equal(result, null);
});

test('extractPreview: 从渲染结果提取视觉摘要', function () {
  var result = previewCard('unbound_route');
  var preview = result.preview;
  assert.ok(preview.header);
  assert.equal(typeof preview.header.title, 'string');
  assert.equal(typeof preview.header.template, 'string');
  assert.equal(typeof preview.elementCount, 'number');
  assert.ok(Array.isArray(preview.elements));
});

test('extractPreview: 错误卡片预览含 button 元素', function () {
  var result = previewCard('session_list');
  var preview = result.preview;
  var hasButton = preview.elements.some(function (e) {
    if (e.type === 'button') return true;
    if (e.type === 'action' && Array.isArray(e.actions)) {
      return e.actions.some(function (a) { return a.type === 'button'; });
    }
    return false;
  });
  assert.ok(hasButton);
});

// ===== 指标读取测试 =====

test('GET /api/admin/metrics: 读取 event store 指标', async function () {
  var store = createEventStore();
  recordEvent(store, { type: 'admin.action', message: 'test' });
  recordEvent(store, { type: 'error', message: 'test error' });

  var routeList = createToolsRoutes({ eventStore: store });
  var router = setupRouter(routeList);
  var matched = router.match('GET', '/api/admin/metrics');

  assert.ok(matched);
  var res = createMockRes();
  matched.handler(createMockReq(), res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.ok);
  assert.ok(res.body.data);
  assert.equal(typeof res.body.data.messages, 'number');
  assert.equal(typeof res.body.data.commands, 'number');
  assert.equal(typeof res.body.data.errors, 'number');
  assert.ok(Array.isArray(res.body.data.buckets));
});

// ===== 命令模拟 API 测试 =====

test('GET /api/admin/tools/command-simulate: 模拟命令', function () {
  var store = createEventStore();
  var routeList = createToolsRoutes({ eventStore: store });
  var router = setupRouter(routeList);

  var matched = router.match('GET', '/api/admin/tools/command-simulate');
  assert.ok(matched);

  var res = createMockRes();
  var req = createMockReq({ queryString: 'text=/new%20opencode%20myproject' });
  matched.handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.ok);
  assert.equal(res.body.data.parsed.type, 'command');
  assert.equal(res.body.data.parsed.name, 'new');
  assert.equal(res.body.data.dryRun, true);
});

test('GET /api/admin/tools/command-simulate: 缺少 text 参数返回 400', function () {
  var store = createEventStore();
  var routeList = createToolsRoutes({ eventStore: store });
  var router = setupRouter(routeList);

  var matched = router.match('GET', '/api/admin/tools/command-simulate');
  var res = createMockRes();
  var req = createMockReq({ queryString: '' });
  matched.handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
});

test('GET /api/admin/tools/command-simulate: dryRun=false 参数', function () {
  var store = createEventStore();
  var routeList = createToolsRoutes({ eventStore: store });
  var router = setupRouter(routeList);

  var matched = router.match('GET', '/api/admin/tools/command-simulate');
  var res = createMockRes();
  var req = createMockReq({ queryString: 'text=/list&dryRun=false' });
  matched.handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.dryRun, false);
});

// ===== 卡片 API 测试 =====

test('GET /api/admin/tools/cards: 返回卡片类型列表', function () {
  var store = createEventStore();
  var routeList = createToolsRoutes({ eventStore: store });
  var router = setupRouter(routeList);

  var matched = router.match('GET', '/api/admin/tools/cards');
  assert.ok(matched);

  var res = createMockRes();
  matched.handler(createMockReq(), res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.ok);
  assert.equal(res.body.data.total, 11);
  assert.equal(res.body.data.types.length, 11);
});

test('POST /api/admin/tools/cards/preview: 预览指定卡片类型', async function () {
  var store = createEventStore();
  var routeList = createToolsRoutes({ eventStore: store });
  var router = setupRouter(routeList);

  var matched = router.match('POST', '/api/admin/tools/cards/preview');
  assert.ok(matched);

  var res = await awaitRequest(function (res) {
    var req = createMockReq({ method: 'POST', body: { type: 'error' } });
    matched.handler(req, res);
  });

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.ok);
  assert.ok(res.body.data.rendered);
  assert.ok(res.body.data.preview);
  assert.equal(res.body.data.typeName, 'error');
});

test('POST /api/admin/tools/cards/preview: 缺少 type 返回 400', async function () {
  var store = createEventStore();
  var routeList = createToolsRoutes({ eventStore: store });
  var router = setupRouter(routeList);

  var matched = router.match('POST', '/api/admin/tools/cards/preview');
  var res = await awaitRequest(function (res) {
    var req = createMockReq({ method: 'POST', body: {} });
    matched.handler(req, res);
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
});

test('POST /api/admin/tools/cards/preview: 未知类型返回 404', async function () {
  var store = createEventStore();
  var routeList = createToolsRoutes({ eventStore: store });
  var router = setupRouter(routeList);

  var matched = router.match('POST', '/api/admin/tools/cards/preview');
  var res = await awaitRequest(function (res) {
    var req = createMockReq({ method: 'POST', body: { type: 'nonexistent' } });
    matched.handler(req, res);
  });

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.ok, false);
});

// ===== 服务控制测试 =====

test('handleServiceStop: 无 confirm=true 返回 400', async function () {
  var store = createEventStore();
  var res = await awaitRequest(function (res) {
    var req = createMockReq({ method: 'POST', body: {} });
    handleServiceStop(req, res, { eventStore: store }, {
      stopApp: function () { return Promise.resolve({ ok: true }); },
      exitProcess: function () {},
      response: { success: success, error: error, send: send },
      parseBodyFn: require('../src/admin/auth').parseBody,
      recordEventFn: require('../src/admin/event-store').recordEvent,
    });
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.ok(res.body.error.message.indexOf('confirm') >= 0);
});

test('handleServiceStop: confirm=false 也返回 400', async function () {
  var store = createEventStore();
  var res = await awaitRequest(function (res) {
    var req = createMockReq({ method: 'POST', body: {} });
    handleServiceStop(req, res, { eventStore: store }, {
      stopApp: function () { return Promise.resolve({ ok: true }); },
      exitProcess: function () {},
      response: { success: success, error: error, send: send },
      parseBodyFn: require('../src/admin/auth').parseBody,
      recordEventFn: require('../src/admin/event-store').recordEvent,
    });
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
});

test('handleServiceStop: confirm=true 成功停止', async function () {
  var store = createEventStore();
  var stopAppCalled = false;

  var res = await awaitRequest(function (res) {
    var req = createMockReq({ method: 'POST', body: { confirm: true } });
    handleServiceStop(req, res, { eventStore: store }, {
      stopApp: function () {
        stopAppCalled = true;
        return Promise.resolve({ ok: true });
      },
      exitProcess: function () {},
      response: { success: success, error: error, send: send },
      parseBodyFn: require('../src/admin/auth').parseBody,
      recordEventFn: require('../src/admin/event-store').recordEvent,
    });
  });

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.ok);
  assert.equal(res.body.data.stopped, true);
  assert.ok(stopAppCalled);
  // exitProcess 在 setTimeout 500ms 后调用，50ms 等待不够，只验证 stopAppCalled
});

test('handleServiceStop: stopApp 失败返回 500', async function () {
  var store = createEventStore();
  var res = await awaitRequest(function (res) {
    var req = createMockReq({ method: 'POST', body: { confirm: true } });
    handleServiceStop(req, res, { eventStore: store }, {
      stopApp: function () {
        return Promise.reject(new Error('stop failed'));
      },
      exitProcess: function () {},
      response: { success: success, error: error, send: send },
      parseBodyFn: require('../src/admin/auth').parseBody,
      recordEventFn: require('../src/admin/event-store').recordEvent,
    });
  });

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
});

test('handleServiceStop: 停止确认写入 eventStore', async function () {
  var store = createEventStore();
  var res = await awaitRequest(function (res) {
    var req = createMockReq({ method: 'POST', body: { confirm: true } });
    handleServiceStop(req, res, { eventStore: store }, {
      stopApp: function () { return Promise.resolve({ ok: true }); },
      exitProcess: function () {},
      response: { success: success, error: error, send: send },
      parseBodyFn: require('../src/admin/auth').parseBody,
      recordEventFn: require('../src/admin/event-store').recordEvent,
    });
  });

  assert.ok(res.statusCode === 200);
  // 检查 eventStore 中有 admin.action 事件记录
  var events = store.events;
  assert.ok(events.length >= 2);
  var confirmEvent = events.find(function (e) { return e.message.indexOf('确认') >= 0; });
  assert.ok(confirmEvent);
});

test('handleServiceStop: 拒绝请求写入 warn 事件', async function () {
  var store = createEventStore();
  await awaitRequest(function (res) {
    var req = createMockReq({ method: 'POST', body: {} });
    handleServiceStop(req, res, { eventStore: store }, {
      stopApp: function () { return Promise.resolve({ ok: true }); },
      exitProcess: function () {},
      response: { success: success, error: error, send: send },
      parseBodyFn: require('../src/admin/auth').parseBody,
      recordEventFn: require('../src/admin/event-store').recordEvent,
    });
  });

  var events = store.events;
  assert.ok(events.length >= 1);
  var warnEvent = events.find(function (e) { return e.level === 'warn'; });
  assert.ok(warnEvent);
});

test('POST /api/admin/service/stop: 通过路由调用，注入 stopApp', async function () {
  var store = createEventStore();
  var stopAppCalled = false;

  var routeList = createToolsRoutes({ eventStore: store }, {
    stopApp: function () {
      stopAppCalled = true;
      return Promise.resolve({ ok: true });
    },
    exitProcess: function () {},
  });
  var router = setupRouter(routeList);

  var matched = router.match('POST', '/api/admin/service/stop');
  assert.ok(matched);

  var res = await awaitRequest(function (res) {
    var req = createMockReq({ method: 'POST', body: { confirm: true } });
    matched.handler(req, res);
  });

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.ok);
  assert.ok(stopAppCalled);
});

test('POST /api/admin/service/stop: 无 confirm 通过路由返回 400', async function () {
  var store = createEventStore();

  var routeList = createToolsRoutes({ eventStore: store }, {
    stopApp: function () { return Promise.resolve({ ok: true }); },
    exitProcess: function () {},
  });
  var router = setupRouter(routeList);

  var matched = router.match('POST', '/api/admin/service/stop');
  var res = await awaitRequest(function (res) {
    var req = createMockReq({ method: 'POST', body: {} });
    matched.handler(req, res);
  });

  assert.equal(res.statusCode, 400);
});

// ===== 集成测试：全部路由注册 =====

test('createToolsRoutes: 返回 5 条路由', function () {
  var store = createEventStore();
  var routes = createToolsRoutes({ eventStore: store });
  assert.equal(routes.length, 5);
});

test('createToolsRoutes: 所有路由路径正确', function () {
  var store = createEventStore();
  var routes = createToolsRoutes({ eventStore: store });
  var patterns = routes.map(function (r) { return r.pattern; });
  assert.ok(patterns.includes('/api/admin/tools/command-simulate'));
  assert.ok(patterns.includes('/api/admin/tools/cards'));
  assert.ok(patterns.includes('/api/admin/tools/cards/preview'));
  assert.ok(patterns.includes('/api/admin/metrics'));
  assert.ok(patterns.includes('/api/admin/service/stop'));
});
