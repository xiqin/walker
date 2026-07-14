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

  _normalizeRoute(state) {
    this._ensureState(state);
    if (state._schemaVersion >= 3) return false;
    let migrated = false;
    for (const routeKey of Object.keys(state.routes)) {
      const value = state.routes[routeKey];
      if (typeof value === 'string') {
        const session = state.sessions[value];
        state.routes[routeKey] = {
          focusSessionId: value,
          sessions: [value],
          cwd: session && session.cwd ? session.cwd : '',
        };
        migrated = true;
      } else if (value && !value.cwd && Array.isArray(value.sessions)) {
        const candidateId = value.focusSessionId || value.sessions[0];
        const session = state.sessions[candidateId] || value.sessions.map((id) => state.sessions[id]).find((s) => s && s.cwd);
        if (session && session.cwd) {
          value.cwd = session.cwd;
          value.updatedAt = value.updatedAt || Date.now();
          migrated = true;
        }
      }
    }
    let allNormalized = true;
    for (const routeKey of Object.keys(state.routes)) {
      const v = state.routes[routeKey];
      if (typeof v === 'string' || (v && !v.cwd && Array.isArray(v.sessions) && v.sessions.length > 0)) {
        allNormalized = false;
        break;
      }
    }
    if (allNormalized && Object.keys(state.routes).length > 0) {
      state._schemaVersion = 3;
    }
    return migrated;
  }

  _readNormalized() {
    const state = this.stateStore.read();
    this._ensureState(state);
    const migrated = this._normalizeRoute(state);
    if (migrated) {
      this.stateStore.update((s) => {
        this._ensureState(s);
        this._normalizeRoute(s);
      });
    }
    return state;
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
      this._normalizeRoute(state);
      state.sessions[id] = session;
      if (route) {
        this._addSessionToRoute(state, route, id, cwd || '');
        state.routes[route].focusSessionId = id;
        state.routes[route].updatedAt = Date.now();
      }
    });

    logger.info('session created', { sessionId: id, agent, route });
    return session;
  }

  getSession(id) {
    const state = this._readNormalized();
    return state.sessions[id] || null;
  }

  getCurrent(routeKey) {
    const state = this._readNormalized();
    const route = state.routes[routeKey];
    if (!route) return null;
    const sessionId = typeof route === 'string' ? route : route.focusSessionId;
    if (!sessionId) return null;
    const session = state.sessions[sessionId];
    if (session && session.status !== 'deleted') return session;
    this.stateStore.update((s) => {
      this._ensureState(s);
      delete s.routes[routeKey];
    });
    return null;
  }

  bindRoute(routeKey, sessionId) {
    const state = this._readNormalized();
    const session = state.sessions[sessionId];
    if (!session) {
      throw new Error('session not found: ' + sessionId);
    }
    if (session.status === 'deleted') {
      throw new Error('session deleted: ' + sessionId);
    }
    this.stateStore.update((s) => {
      this._ensureState(s);
      this._normalizeRoute(s);
      this._addSessionToRoute(s, routeKey, sessionId, '');
      s.routes[routeKey].focusSessionId = sessionId;
      s.routes[routeKey].updatedAt = Date.now();
    });
    logger.info('route bound', { routeKey, sessionId });
  }

  unbindRoute(routeKey) {
    this.stateStore.update((s) => {
      this._ensureState(s);
      this._normalizeRoute(s);
      const route = s.routes[routeKey];
      if (!route) return;
      const focusId = route.focusSessionId;
      const remaining = route.sessions.filter((id) => id !== focusId);
      if (remaining.length === 0) {
        delete s.routes[routeKey];
      } else {
        route.sessions = remaining;
        route.focusSessionId = remaining[0];
        route.updatedAt = Date.now();
      }
    });
    logger.info('route unbound', { routeKey });
  }

  getRouteForSession(sessionId) {
    const state = this._readNormalized();
    const entries = Object.entries(state.routes || {});
    const found = entries.find(([, route]) => route && Array.isArray(route.sessions) && route.sessions.includes(sessionId));
    return found ? found[0] : null;
  }

  listSessions() {
    const state = this._readNormalized();
    return Object.values(state.sessions).filter((s) => s.status !== 'deleted');
  }

  listRoutes() {
    const state = this._readNormalized();
    return state.routes || {};
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
    const state = this._readNormalized();
    const session = state.sessions[sessionId];
    if (!session) return;

    this.stateStore.update((s) => {
      this._ensureState(s);
      this._normalizeRoute(s);
      if (s.sessions[sessionId]) {
        s.sessions[sessionId].status = 'deleted';
        s.sessions[sessionId].updatedAt = Date.now();
      }
      for (const routeKey of Object.keys(s.routes)) {
        const route = s.routes[routeKey];
        if (!route || !Array.isArray(route.sessions)) continue;
        if (!route.sessions.includes(sessionId)) continue;
        route.sessions = route.sessions.filter((id) => id !== sessionId);
        if (route.sessions.length === 0) {
          delete s.routes[routeKey];
        } else if (route.focusSessionId === sessionId) {
          route.focusSessionId = route.sessions[0];
          route.updatedAt = Date.now();
        }
      }
    });

    logger.info('session deleted', { sessionId });
  }

  _updateState(sessionId, status, extra) {
    this.stateStore.update((state) => {
      this._ensureState(state);
      this._normalizeRoute(state);
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

  static UPDATEABLE_FIELDS = ['model', 'agentRef', 'title', 'cwd'];

  updateSessionField(sessionId, field, value) {
    if (!SessionService.UPDATEABLE_FIELDS.includes(field)) {
      throw new Error('Field not allowed: ' + field + '. Allowed: ' + SessionService.UPDATEABLE_FIELDS.join(', '));
    }
    this.stateStore.update((state) => {
      this._ensureState(state);
      this._normalizeRoute(state);
      const session = state.sessions[sessionId];
      if (!session) return;
      session[field] = value;
      session.updatedAt = Date.now();
    });
    logger.info('session field updated', { sessionId, field });
  }

  recoverOnStartup() {
    const state = this._readNormalized();
    const recovered = [];
    this.stateStore.update((s) => {
      this._ensureState(s);
      this._normalizeRoute(s);
      for (const id of Object.keys(s.sessions)) {
        const session = s.sessions[id];
        if (session.status === 'running' || session.status === 'error') {
          const previousStatus = session.status;
          session.status = 'idle';
          session.errorMessage = null;
          session.updatedAt = Date.now();
          recovered.push(id);
          logger.info('recovered session to idle on startup', { sessionId: id, previousStatus });
        }
      }
    });
    return recovered;
  }

  cleanOrphanRoutes() {
    const state = this._readNormalized();
    const cleaned = [];
    this.stateStore.update((s) => {
      this._ensureState(s);
      this._normalizeRoute(s);
      for (const routeKey of Object.keys(s.routes)) {
        const route = s.routes[routeKey];
        if (!route || !Array.isArray(route.sessions)) {
          delete s.routes[routeKey];
          cleaned.push(routeKey);
          logger.info('cleaned orphan route', { routeKey, sessionId: null });
          continue;
        }
        const validSessions = route.sessions.filter((id) => {
          const sess = s.sessions[id];
          return sess && sess.status !== 'deleted';
        });
        if (validSessions.length === 0) {
          delete s.routes[routeKey];
          cleaned.push(routeKey);
          logger.info('cleaned orphan route', { routeKey, sessionId: route.focusSessionId });
        } else if (validSessions.length !== route.sessions.length) {
          route.sessions = validSessions;
          if (!validSessions.includes(route.focusSessionId)) {
            route.focusSessionId = validSessions[0];
          }
          route.updatedAt = Date.now();
        }
      }
    });
    return cleaned;
  }

  _addSessionToRoute(state, routeKey, sessionId, cwd) {
    this._ensureState(state);
    let route = state.routes[routeKey];
    if (!route) {
      route = {
        focusSessionId: sessionId,
        sessions: [sessionId],
        cwd: cwd || '',
        updatedAt: Date.now(),
      };
      state.routes[routeKey] = route;
    } else {
      if (!route.sessions.includes(sessionId)) {
        route.sessions.push(sessionId);
      }
      if (!route.cwd && cwd) {
        route.cwd = cwd;
      }
      route.updatedAt = Date.now();
    }
  }

  addSessionToRoute(routeKey, sessionId, cwd) {
    this.stateStore.update((state) => {
      this._ensureState(state);
      this._normalizeRoute(state);
      this._addSessionToRoute(state, routeKey, sessionId, cwd || '');
    });
    logger.info('session added to route', { routeKey, sessionId });
  }

  setFocus(routeKey, sessionId) {
    const state = this._readNormalized();
    const route = state.routes[routeKey];
    if (!route) {
      throw new Error('route not found: ' + routeKey);
    }
    if (!route.sessions.includes(sessionId)) {
      throw new Error('session not in route: ' + sessionId);
    }
    this.stateStore.update((s) => {
      this._ensureState(s);
      this._normalizeRoute(s);
      const r = s.routes[routeKey];
      if (!r) {
        throw new Error('route not found during update: ' + routeKey);
      }
      r.focusSessionId = sessionId;
      r.updatedAt = Date.now();
    });
    logger.info('focus set', { routeKey, sessionId });
  }

  removeSessionFromRoute(routeKey, sessionId) {
    this.stateStore.update((state) => {
      this._ensureState(state);
      this._normalizeRoute(state);
      const route = state.routes[routeKey];
      if (!route || !route.sessions.includes(sessionId)) return;
      route.sessions = route.sessions.filter((id) => id !== sessionId);
      if (route.sessions.length === 0) {
        delete state.routes[routeKey];
      } else if (route.focusSessionId === sessionId) {
        route.focusSessionId = route.sessions[0];
        route.updatedAt = Date.now();
      }
    });
    logger.info('session removed from route', { routeKey, sessionId });
  }

  listSessionsInRoute(routeKey) {
    const state = this._readNormalized();
    const route = state.routes[routeKey];
    if (!route || !Array.isArray(route.sessions)) return [];
    const focusId = route.focusSessionId;
    const sessions = route.sessions
      .map((id) => state.sessions[id])
      .filter((s) => s && s.status !== 'deleted');
    const focusIndex = sessions.findIndex((s) => s.id === focusId);
    if (focusIndex > 0) {
      const [focus] = sessions.splice(focusIndex, 1);
      sessions.unshift(focus);
    }
    return sessions;
  }

  getRouteCwd(routeKey) {
    const state = this._readNormalized();
    const route = state.routes[routeKey];
    if (!route) return '';
    return route.cwd || '';
  }

  setRouteCwd(routeKey, cwd) {
    this.stateStore.update((state) => {
      this._ensureState(state);
      this._normalizeRoute(state);
      let route = state.routes[routeKey];
      if (!route) {
        route = {
          focusSessionId: '',
          sessions: [],
          cwd: cwd || '',
          updatedAt: Date.now(),
        };
        state.routes[routeKey] = route;
      } else {
        route.cwd = cwd || '';
        route.updatedAt = Date.now();
      }
    });
    logger.info('route cwd set', { routeKey, cwd });
  }

  touchRoute(routeKey) {
    this.stateStore.update((state) => {
      this._ensureState(state);
      this._normalizeRoute(state);
      const route = state.routes[routeKey];
      if (!route) return;
      const now = Date.now();
      route.lastActiveAt = now;
      route.updatedAt = now;
    });
    logger.info('route touched', { routeKey });
  }
}

module.exports = { SessionService };
