const { createId } = require('./id');
const { createLogger } = require('./logger');

const logger = createLogger('session-service');

/**
 * 会话管理服务，负责创建、查询、绑定路由、状态更新和删除会话
 */
class SessionService {
  /**
   * 初始化会话服务
   * @param {Object} options - 初始化选项
   * @param {JsonStore} options.sessionsStore - 会话数据的持久化存储
   * @param {JsonStore} options.routesStore - 路由映射的持久化存储
   */
  constructor({ sessionsStore, routesStore }) {
    this.sessionsStore = sessionsStore;
    this.routesStore = routesStore;
  }

  /**
   * 创建新会话并可选绑定到路由键
   * @param {Object} options - 创建选项
   * @param {string} [options.route] - 要绑定的路由键
   * @param {string} [options.agent] - Agent 类型名称，默认 'opencode'
   * @param {string} [options.title] - 会话标题
   * @param {string} [options.runtime] - 运行时类型，默认 'windows'
   * @param {string} [options.cwd] - 工作目录
   * @param {Object} [options.agentRef] - Agent 驱动的会话引用
   * @returns {Object} 新创建的会话对象
   */
  createSession({ route, agent, title, runtime, cwd, agentRef }) {
    const id = createId('wks_');
    const session = {
      id,
      agent: agent || 'opencode',
      title: title || ('session ' + id.slice(0, 12)),
      runtime: runtime || 'windows',
      cwd: cwd || '',
      state: 'created',
      agentRef: agentRef || null,
      errorMessage: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.sessionsStore.update((data) => { data[id] = session; });
    if (route) {
      this.routesStore.update((data) => { data[route] = id; });
    }

    logger.info('session created', { sessionId: id, agent, route });
    return session;
  }

  /**
   * 根据会话 ID 获取会话信息
   * @param {string} id - 会话标识符
   * @returns {Object|null} 会话对象，不存在则返回 null
   */
  getSession(id) {
    const data = this.sessionsStore.read();
    return data[id] || null;
  }

  /**
   * 根据路由键获取当前绑定的会话
   * @param {string} routeKey - 路由键
   * @returns {Object|null} 当前绑定的会话对象，未绑定则返回 null
   */
  getCurrent(routeKey) {
    const routes = this.routesStore.read();
    const sessionId = routes[routeKey];
    if (!sessionId) return null;
    return this.getSession(sessionId);
  }

  /**
   * 将路由键绑定到指定会话
   * @param {string} routeKey - 路由键
   * @param {string} sessionId - 要绑定的会话 ID
   */
  bindRoute(routeKey, sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('session not found: ' + sessionId);
    }
    this.routesStore.update((data) => { data[routeKey] = sessionId; });
    logger.info('route bound', { routeKey, sessionId });
  }

  /**
   * 解除路由键的会话绑定
   * @param {string} routeKey - 要解绑的路由键
   */
  unbindRoute(routeKey) {
    this.routesStore.update((data) => { delete data[routeKey]; });
    logger.info('route unbound', { routeKey });
  }

  /**
   * 列出所有未删除的会话
   * @returns {Object[]} 活跃会话列表
   */
  listSessions() {
    const data = this.sessionsStore.read();
    return Object.values(data).filter((s) => s.state !== 'deleted');
  }

  /**
   * 标记会话为运行中状态
   * @param {string} sessionId - 会话 ID
   */
  markRunning(sessionId) {
    this._updateState(sessionId, 'running');
  }

  /**
   * 标记会话为空闲状态
   * @param {string} sessionId - 会话 ID
   */
  markIdle(sessionId) {
    this._updateState(sessionId, 'idle');
  }

  /**
   * 标记会话为错误状态并记录错误信息
   * @param {string} sessionId - 会话 ID
   * @param {string} errorMessage - 错误描述信息
   */
  markError(sessionId, errorMessage) {
    this._updateState(sessionId, 'error', { errorMessage });
  }

  /**
   * 标记会话为已停止状态
   * @param {string} sessionId - 会话 ID
   */
  stopSession(sessionId) {
    this._updateState(sessionId, 'stopped');
  }

  /**
   * 删除会话，同时清除所有关联的路由绑定
   * @param {string} sessionId - 要删除的会话 ID
   */
  deleteSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return;

    this.sessionsStore.update((data) => {
      data[sessionId].state = 'deleted';
      data[sessionId].updatedAt = Date.now();
    });

    this.routesStore.update((data) => {
      for (const key of Object.keys(data)) {
        if (data[key] === sessionId) delete data[key];
      }
    });

    logger.info('session deleted', { sessionId });
  }

  /**
   * 内部方法：更新会话状态和额外字段
   * @param {string} sessionId - 会话 ID
   * @param {string} state - 新状态值
   * @param {Object} [extra] - 需要同时更新的额外字段
   */
  _updateState(sessionId, state, extra) {
    this.sessionsStore.update((data) => {
      if (!data[sessionId]) return;
      data[sessionId].state = state;
      data[sessionId].updatedAt = Date.now();
      if (extra) {
        for (const k of Object.keys(extra)) { data[sessionId][k] = extra[k]; }
      }
    });
  }
}

module.exports = { SessionService };
