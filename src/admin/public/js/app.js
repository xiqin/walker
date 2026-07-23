import { createApiClient } from './api.js';
import { createRouter } from './router.js';
import { createInitialState, createStore } from './state.js';
import { createAppShell } from './components/app-shell.js';

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
    root: shell.main,
    routes: options.pages || {},
    context: { api, store, shell, document: documentRef, window: windowRef },
    onRoute: route => {
      shell.setActiveRoute(route.name);
      shell.setNavigationOpen(false);
      store.update(state => ({ ...state, route }));
    },
  });
  await router.start();
  return { api, router, shell, store, authRecovery: recovery, cleanup: () => { router.stop(); shell.cleanup(); } };
}
