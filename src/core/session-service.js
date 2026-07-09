const { createId } = require('./id');
const { createLogger } = require('./logger');

const logger = createLogger('session-service');

class SessionService {
  constructor({ sessionsStore, routesStore }) {
    this.sessionsStore = sessionsStore;
    this.routesStore = routesStore;
  }

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

  getSession(id) {
    const data = this.sessionsStore.read();
    return data[id] || null;
  }

  getCurrent(routeKey) {
    const routes = this.routesStore.read();
    const sessionId = routes[routeKey];
    if (!sessionId) return null;
    return this.getSession(sessionId);
  }

  bindRoute(routeKey, sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('session not found: ' + sessionId);
    }
    this.routesStore.update((data) => { data[routeKey] = sessionId; });
    logger.info('route bound', { routeKey, sessionId });
  }

  unbindRoute(routeKey) {
    this.routesStore.update((data) => { delete data[routeKey]; });
    logger.info('route unbound', { routeKey });
  }

  listSessions() {
    const data = this.sessionsStore.read();
    return Object.values(data).filter((s) => s.state !== 'deleted');
  }

  markRunning(sessionId) {
    this._updateState(sessionId, 'running');
  }

  markIdle(sessionId) {
    this._updateState(sessionId, 'idle');
  }

  markError(sessionId, errorMessage) {
    this._updateState(sessionId, 'error', { errorMessage });
  }

  stopSession(sessionId) {
    this._updateState(sessionId, 'stopped');
  }

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
