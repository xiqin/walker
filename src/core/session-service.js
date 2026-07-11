const { createId } = require('./id');
const { createLogger } = require('./logger');

const logger = createLogger('session-service');

class SessionService {
  constructor({ stateStore }) {
    this.stateStore = stateStore;
  }

  _ensureState(state) {
    if (!state.sessions) state.sessions = {};
    if (!state.routes) state.routes = {};
  }

  createSession({ route, agent, title, runtime, cwd, agentRef }) {
    const id = createId('wks_');
    const session = {
      id,
      agent: agent || 'opencode',
      title: title || ('session ' + id.slice(0, 12)),
      runtime: runtime || 'windows',
      cwd: cwd || '',
      status: 'created',
      agentRef: agentRef || null,
      errorMessage: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.stateStore.update((state) => {
      this._ensureState(state);
      state.sessions[id] = session;
      if (route) state.routes[route] = id;
    });

    logger.info('session created', { sessionId: id, agent, route });
    return session;
  }

  getSession(id) {
    const state = this.stateStore.read();
    this._ensureState(state);
    return state.sessions[id] || null;
  }

  getCurrent(routeKey) {
    const state = this.stateStore.read();
    this._ensureState(state);
    const sessionId = state.routes[routeKey];
    if (!sessionId) return null;
    const session = state.sessions[sessionId];
    if (session && session.status !== 'deleted') return session;
    this.stateStore.update((s) => { this._ensureState(s); delete s.routes[routeKey]; });
    return null;
  }

  bindRoute(routeKey, sessionId) {
    const state = this.stateStore.read();
    this._ensureState(state);
    const session = state.sessions[sessionId];
    if (!session) {
      throw new Error('session not found: ' + sessionId);
    }
    if (session.status === 'deleted') {
      throw new Error('session deleted: ' + sessionId);
    }
    this.stateStore.update((s) => { this._ensureState(s); s.routes[routeKey] = sessionId; });
    logger.info('route bound', { routeKey, sessionId });
  }

  unbindRoute(routeKey) {
    this.stateStore.update((s) => { this._ensureState(s); delete s.routes[routeKey]; });
    logger.info('route unbound', { routeKey });
  }

  getRouteForSession(sessionId) {
    const state = this.stateStore.read();
    this._ensureState(state);
    const entries = Object.entries(state.routes || {});
    const found = entries.find(([, id]) => id === sessionId);
    return found ? found[0] : null;
  }

  listSessions() {
    const state = this.stateStore.read();
    this._ensureState(state);
    return Object.values(state.sessions).filter((s) => s.status !== 'deleted');
  }

  markRunning(sessionId) {
    this._updateState(sessionId, 'running');
  }

  markIdle(sessionId) {
    this._updateState(sessionId, 'idle', { errorMessage: null });
  }

  markError(sessionId, errorMessage) {
    this._updateState(sessionId, 'error', { errorMessage });
  }

  stopSession(sessionId) {
    this._updateState(sessionId, 'stopped');
  }

  deleteSession(sessionId) {
    const state = this.stateStore.read();
    this._ensureState(state);
    const session = state.sessions[sessionId];
    if (!session) return;

    this.stateStore.update((s) => {
      this._ensureState(s);
      if (s.sessions[sessionId]) {
        s.sessions[sessionId].status = 'deleted';
        s.sessions[sessionId].updatedAt = Date.now();
      }
      for (const key of Object.keys(s.routes)) {
        if (s.routes[key] === sessionId) delete s.routes[key];
      }
    });

    logger.info('session deleted', { sessionId });
  }

  _updateState(sessionId, status, extra) {
    this.stateStore.update((state) => {
      this._ensureState(state);
      const session = state.sessions[sessionId];
      if (!session) return;
      if (session.status === 'stopped' || session.status === 'deleted') return;
      session.status = status;
      session.updatedAt = Date.now();
      if (extra) {
        for (const k of Object.keys(extra)) { session[k] = extra[k]; }
      }
    });
  }

  updateSessionField(sessionId, field, value) {
    this.stateStore.update((state) => {
      this._ensureState(state);
      const session = state.sessions[sessionId];
      if (!session) return;
      session[field] = value;
      session.updatedAt = Date.now();
    });
    logger.info('session field updated', { sessionId, field, value });
  }

  recoverOnStartup() {
    const state = this.stateStore.read();
    this._ensureState(state);
    const recovered = [];
    this.stateStore.update((s) => {
      this._ensureState(s);
      for (const id of Object.keys(s.sessions)) {
        const session = s.sessions[id];
        if (session.status === 'running' || session.status === 'error') {
          session.status = 'idle';
          session.errorMessage = null;
          session.updatedAt = Date.now();
          recovered.push(id);
          logger.info('recovered session to idle on startup', { sessionId: id, previousStatus: session.status });
        }
      }
    });
    return recovered;
  }

  cleanOrphanRoutes() {
    const state = this.stateStore.read();
    this._ensureState(state);
    const cleaned = [];
    this.stateStore.update((s) => {
      this._ensureState(s);
      for (const routeKey of Object.keys(s.routes)) {
        const sessionId = s.routes[routeKey];
        const session = s.sessions[sessionId];
        if (!session || session.status === 'deleted') {
          delete s.routes[routeKey];
          cleaned.push(routeKey);
          logger.info('cleaned orphan route', { routeKey, sessionId });
        }
      }
    });
    return cleaned;
  }
}

module.exports = { SessionService };
