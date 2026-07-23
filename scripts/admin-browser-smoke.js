'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createAdminServerFromContext } = require('../src/admin');
const { createEventStore } = require('../src/admin/event-store');

const SECRET = 'ADMIN_BROWSER_SMOKE_SECRET';

function findBrowser() {
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const relatives = [
    path.join('Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join('Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join('Chromium', 'Application', 'chrome.exe'),
  ];
  for (const root of roots) {
    for (const relative of relatives) {
      const candidate = path.join(root, relative);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 10000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error('等待浏览器条件超时');
}

function createCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const callback = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message));
      else callback.resolve(message.result);
      return;
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params || {});
  });
  return {
    open: new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    }),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, listener) {
      const current = listeners.get(method) || [];
      current.push(listener);
      listeners.set(method, current);
    },
    close() { socket.close(); },
  };
}

function createSmokeContext() {
  const eventStore = createEventStore();
  eventStore.events.push({ id: 1, timestamp: Date.now(), level: 'info', type: 'session.state', sessionId: 'wks_smoke', routeKey: 'route-smoke', message: 'ready' });
  const session = {
    id: 'wks_smoke', title: 'Smoke Session', agent: 'opencode', status: 'idle', runtime: 'windows', cwd: process.cwd(),
    agentRef: { opencodeSessionId: 'ses_smoke', transport: 'tui-bridge' }, createdAt: Date.now(), updatedAt: Date.now(),
  };
  const state = {
    sessions: { [session.id]: session },
    routes: { 'route-smoke': { focusSessionId: session.id, sessions: [session.id], cwd: process.cwd(), updatedAt: Date.now() } },
  };
  const sessionService = {
    stateStore: { read: () => state },
    listSessions: () => [session],
    getSession: id => id === session.id ? session : null,
    getRouteForSession: id => id === session.id ? 'route-smoke' : null,
    setFocus: (routeKey, sessionId) => { state.routes[routeKey].focusSessionId = sessionId; },
    addSessionToRoute: () => {}, removeSessionFromRoute: () => false, setRouteCwd: () => {}, deleteRoute: () => false,
    unbindRoute: routeKey => { delete state.routes[routeKey]; },
  };
  return {
    sessionService,
    registry: { list: () => ['opencode'], get: () => ({ getStatus: () => ({ ready: true }), ensureReady: async () => true }) },
    eventStore,
    envConfig: { feishuAppSecret: SECRET, admin: { token: SECRET }, walkerDefaultRuntime: 'windows', walkerDefaultCwd: process.cwd() },
    env: {},
    platform: { getStatus: () => ({ connected: true }) },
    dispatcher: { getWatchSnapshot: () => ({ status: 'healthy' }) },
    healthPoller: { getHealthSnapshots: () => [{ status: 'healthy' }] },
    tuiBridge: { getStatus: () => ({ status: 'healthy' }), getRuntimeSnapshots: () => [], getRuntimeSnapshot: () => null },
    dataDir: path.join(os.tmpdir(), 'walker-admin-browser-smoke-data'),
    version: 'smoke', startTime: Date.now(), runtime: { type: 'windows' },
    config: { enabled: true, host: '127.0.0.1', port: 0, token: SECRET },
  };
}

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.log('SKIP admin browser smoke: 未找到本机 Chrome、Edge 或 Chromium；按任务约定退出码为 0。');
    return;
  }

  const adminServer = createAdminServerFromContext(createSmokeContext());
  const address = await adminServer.start();
  const baseUrl = `http://${address.host}:${address.port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-admin-smoke-'));
  const browser = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });
  let cdp;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    const debugPort = await waitFor(() => fs.existsSync(portFile) && Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]));
    const targets = await waitFor(async () => {
      const list = await requestJson(`http://127.0.0.1:${debugPort}/json/list`);
      return list.filter(item => item.type === 'page');
    });
    cdp = createCdp(targets[0].webSocketDebuggerUrl);
    await cdp.open;
    const consoleErrors = [];
    cdp.on('Runtime.consoleAPICalled', params => {
      if (params.type === 'error') consoleErrors.push(params.args.map(arg => arg.value || arg.description || '').join(' '));
    });
    cdp.on('Runtime.exceptionThrown', params => consoleErrors.push(params.exceptionDetails.text || 'page exception'));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: baseUrl + '/#dashboard' });
    await waitFor(async () => (await evaluate(cdp, `document.querySelector('#login-token') && !document.querySelector('#login').hidden`)));
    await evaluate(cdp, `document.querySelector('#login-token').value=${JSON.stringify(SECRET)}; document.querySelector('#login-form').requestSubmit();`);
    await waitForPage(cdp, '#dashboard', '.dashboard-page');
    await assertDashboard(cdp, 1440);
    await verifyRuntimeAuthRecovery(cdp, baseUrl);

    for (const page of [
      ['#dashboard', '.dashboard-page'],
      ['#sessions/wks_smoke', '.session-detail'],
      ['#config', '#config-title'],
      ['#diagnostics', '#diagnostics-title'],
      ['#tools', '#tools-title'],
    ]) {
      await navigateHash(cdp, page[0], page[1]);
      await assertNoSecretDom(cdp, page[0]);
    }

    for (const width of [390, 768, 1199, 1440]) {
      await verifyViewport(cdp, baseUrl, width);
    }

    if (consoleErrors.length) throw new Error('浏览器 console/page error: ' + consoleErrors.join(' | '));
    console.log('PASS admin browser smoke: 登录、运行中 401 重登录恢复、Dashboard、五页面 Secret 扫描、Session 抽屉、Route Tab、移动导航、390/768/1199/1440 布局、console 扫描通过。');
  } finally {
    cdp?.close();
    browser.kill();
    await adminServer.stop();
    await delay(250);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '浏览器表达式失败');
  return result.result.value;
}

async function navigateHash(cdp, hash, selector) {
  await evaluate(cdp, `location.hash=${JSON.stringify(hash)}`);
  await waitForPage(cdp, hash, selector);
}

async function waitForPage(cdp, hash, selector) {
  await waitFor(async () => evaluate(cdp, `location.hash===${JSON.stringify(hash)} && Boolean(document.querySelector(${JSON.stringify(selector)}))`));
}

async function assertNoSecretDom(cdp, page) {
  const leaked = await evaluate(cdp, `document.documentElement.textContent.includes(${JSON.stringify(SECRET)})`);
  if (leaked) throw new Error(`${page} DOM 出现 Secret`);
}

async function assertDashboard(cdp, width) {
  const result = await evaluate(cdp, `(() => ({
    title: document.querySelector('.dashboard-page h1')?.textContent,
    groups: document.querySelectorAll('.app-sidebar .nav-group').length,
    links: document.querySelectorAll('.app-sidebar .nav-link').length,
    status: [...document.querySelectorAll('.workspace-section h2')].some(e=>e.textContent==='服务状态'),
    issues: [...document.querySelectorAll('.workspace-section h2')].some(e=>e.textContent==='需处理问题')
  }))()`);
  if (result.title !== '控制台' || result.groups !== 4 || result.links !== 8 || !result.status || !result.issues) {
    throw new Error(`${width}px Dashboard 稳定结构不完整: ${JSON.stringify(result)}`);
  }
}

async function verifyRuntimeAuthRecovery(cdp, baseUrl) {
  await cdp.send('Network.deleteCookies', { name: 'walker_admin_sid', url: baseUrl });
  await evaluate(cdp, `location.hash='#sessions/wks_smoke'`);
  await waitFor(async () => evaluate(cdp, `document.querySelector('#login').hidden===false && document.querySelector('#app').hidden===true`));
  await evaluate(cdp, `document.querySelector('#login-token').value=${JSON.stringify(SECRET)}; document.querySelector('#login-form').requestSubmit();`);
  await waitFor(async () => evaluate(cdp, `location.hash==='#sessions/wks_smoke' && document.querySelector('#login').hidden===true && document.querySelector('#app').hidden===false && Boolean(document.querySelector('.session-detail'))`));
}

async function verifyViewport(cdp, baseUrl, width) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
  await cdp.send('Page.navigate', { url: `${baseUrl}/#dashboard` });
  await waitForPage(cdp, '#dashboard', '.dashboard-page');
  await assertDashboard(cdp, width);
  await assertLayout(cdp, width, [width < 768 ? '.nav-toggle' : '.app-sidebar .nav-link', '.dashboard-page h1']);
  await assertNoSecretDom(cdp, `${width}px Dashboard`);

  if (width < 768) await verifyMobileNavigation(cdp, width);

  await navigateHash(cdp, '#sessions/wks_smoke', '.session-detail');
  await assertLayout(cdp, width, ['.session-detail', '[aria-label="关闭详情"]']);
  await assertNoSecretDom(cdp, `${width}px Session`);
  if (width === 1440) await verifyDesktopDrawer(cdp);

  await navigateHash(cdp, '#sessions?tab=routes', '.route-toolbar');
  await assertLayout(cdp, width, ['.route-toolbar', '[aria-label="Session ID"]']);
  const routeActions = await evaluate(cdp, `[...document.querySelectorAll('.route-actions button')].filter(button=>button.getBoundingClientRect().width>0).length`);
  if (routeActions !== 6) throw new Error(`${width}px Route 操作不可完整到达: ${routeActions}`);
  await assertNoSecretDom(cdp, `${width}px Route`);
}

async function verifyMobileNavigation(cdp, width) {
  await cdp.send('Page.bringToFront');
  await evaluate(cdp, `window.focus(); document.querySelector('.nav-toggle').focus(); document.querySelector('.nav-toggle').click()`);
  await waitFor(async () => evaluate(cdp, `document.querySelector('.app-shell').dataset.navOpen==='true' && !document.querySelector('.app-sidebar').hidden && !document.querySelector('.app-sidebar').inert`));
  const opened = await evaluate(cdp, `(() => ({
    links: [...document.querySelectorAll('.app-sidebar .nav-link')].filter(link=>link.getBoundingClientRect().width>0).length,
    focused: document.activeElement?.classList.contains('nav-link')
  }))()`);
  if (opened.links !== 8) throw new Error(`${width}px 移动导航入口不可达: ${JSON.stringify(opened)}`);
  await evaluate(cdp, `document.querySelector('.app-sidebar .nav-link').focus()`);
  await waitFor(async () => evaluate(cdp, `document.activeElement?.classList.contains('nav-link')`));
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  try {
    await waitFor(async () => evaluate(cdp, `document.querySelector('.app-shell').dataset.navOpen==='false' && document.activeElement===document.querySelector('.nav-toggle')`));
  } catch (error) {
    const state = await evaluate(cdp, `({open:document.querySelector('.app-shell').dataset.navOpen,active:document.activeElement?.outerHTML})`);
    throw new Error(`${width}px Escape 未关闭导航或恢复焦点: ${JSON.stringify(state)}`, { cause: error });
  }
}

async function verifyDesktopDrawer(cdp) {
  const drawer = await evaluate(cdp, `(() => { const drawer=document.querySelector('.drawer'), close=document.querySelector('[aria-label="关闭详情"]'); const d=drawer.getBoundingClientRect(), c=close.getBoundingClientRect(); return {left:d.left,right:d.right,width:d.width,closeVisible:c.left>=0&&c.right<=innerWidth&&c.top>=0&&c.bottom<=innerHeight}; })()`);
  if (drawer.right > 1440 || drawer.left < 720 || !drawer.closeVisible) throw new Error(`1440px Session 抽屉位置或关闭操作异常: ${JSON.stringify(drawer)}`);
  await evaluate(cdp, `document.querySelector('[aria-label="关闭详情"]').click()`);
  await waitFor(async () => evaluate(cdp, `location.hash.startsWith('#sessions?') && document.querySelector('.drawer')?.getAttribute('aria-hidden')==='true'`));
}

async function assertLayout(cdp, width, selectors) {
  const result = await evaluate(cdp, `(() => {
    const visible=e=>{if(!e)return false;const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&!e.hidden&&r.width>0&&r.height>0};
    const rects=${JSON.stringify(selectors)}.map(selector=>{const e=document.querySelector(selector),r=e?.getBoundingClientRect();return {selector,visible:visible(e),left:r?.left,right:r?.right,top:r?.top,bottom:r?.bottom};});
    return {scrollWidth:document.documentElement.scrollWidth,innerWidth,innerHeight,rects};
  })()`);
  const invalid = result.rects.filter(rect => !rect.visible || rect.left < -1 || rect.right > result.innerWidth + 1 || rect.bottom < 0 || rect.top > result.innerHeight);
  if (result.scrollWidth > result.innerWidth || invalid.length) throw new Error(`${width}px 页面宽度或关键操作不可见: ${JSON.stringify({ ...result, invalid })}`);
}

main().catch(error => {
  console.error('FAIL admin browser smoke:', error.stack || error.message);
  process.exitCode = 1;
});
