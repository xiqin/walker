import { createApiClient } from './api.js';
import { createRouter } from './router.js';
import { createInitialState, createStore } from './state.js';
import { createAppShell } from './components/app-shell.js';
import { listen } from './dom.js';

const RETURN_HASH_KEY = 'walker.admin.returnHash';

/** 创建 401 登录恢复状态，目标 hash 仅消费一次。 */
export function createAuthRecovery(options = {}) {
  const storage = options.storage || sessionStorage;
  const getHash = options.getHash || (() => location.hash || '#dashboard');
  /** 消费保存目标，保证目标最多使用一次。 */
  function consume() {
    const hash = storage.getItem(RETURN_HASH_KEY) || null;
    storage.removeItem(RETURN_HASH_KEY);
    return hash;
  }
  return {
    remember() {
      storage.setItem(RETURN_HASH_KEY, getHash() || '#dashboard');
    },
    consume,
    /** 认证成功后消费一次目标并交给 Router 恢复页面。 */
    async resume(router) {
      const target = consume() || '#dashboard';
      await router.navigate(target);
      return target;
    },
  };
}

function clockTime(date) {
  const value = date || new Date();
  const pad = n => String(n).padStart(2, '0');
  return pad(value.getHours()) + ':' + pad(value.getMinutes()) + ':' + pad(value.getSeconds());
}

function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知';
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${mins} 分`;
  if (mins > 0) return `${mins} 分`;
  return `${total} 秒`;
}

function responseData(response) {
  return response && Object.hasOwn(response, 'data') ? response.data : response;
}

/** 启动无构建 Admin 应用并返回可显式释放的运行时。 */
export async function startApp(options = {}) {
  const documentRef = options.document || document;
  const windowRef = options.window || window;
  const mountPoint = options.mountPoint || documentRef.getElementById('app');
  const store = options.store || createStore(createInitialState());
  const recovery = options.authRecovery || createAuthRecovery({ storage: windowRef.sessionStorage, getHash: () => windowRef.location.hash });
  const shell = createAppShell({ document: documentRef, navigation: options.navigation });
  mountPoint.replaceChildren(shell.element);
  const api = options.api || createApiClient({
    getToken: () => store.getState().auth.token,
    onUnauthorized: recovery.remember,
  });
  const router = createRouter({
    window: windowRef,
    root: shell.viewport,
    routes: options.pages || {},
    context: { api, store, shell, document: documentRef, window: windowRef },
    onRoute: route => {
      shell.setActiveRoute(route.name);
      shell.setNavigationOpen(false);
      store.update(state => ({ ...state, route }));
    },
  });
  await router.start();

  /** 取 /overview 设置底部状态药丸（失败显示诚实未知态，不造假 PID）。 */
  async function loadStatus() {
    try {
      const overview = responseData(await api.get('/api/admin/overview', { signal: undefined }));
      const process = overview && overview.process ? overview.process : null;
      const pid = process && process.pid;
      const uptime = process ? formatUptime(process.uptime) : '未知';
      shell.setStatus(pid ? `walker 运行中 · PID ${pid} · ${uptime}` : 'Walker 状态未知', pid ? 'green' : 'gray');
    } catch (_err) {
      shell.setStatus('Walker 状态未知', 'gray');
    }
  }
  shell.setClock(clockTime());
  const clockTimer = windowRef.setInterval(() => shell.setClock(clockTime()), 1000);
  const offRefresh = listen(shell.viewport, 'walker:refresh', () => { loadStatus(); });
  loadStatus();

  return {
    api, router, shell, store, authRecovery: recovery,
    cleanup: () => { router.stop(); shell.cleanup(); windowRef.clearInterval(clockTimer); offRefresh(); },
  };
}
