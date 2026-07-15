'use strict';

const { createId } = require('../core/id');
const { createLogger } = require('../core/logger');
const { AgentEvent } = require('../drivers/agent-driver');
const { findRouteKeyByCwd } = require('../opencode-hook/receiver');

const logger = createLogger('opencode-tui-bridge');

class OpencodeTuiBridge {
  constructor(options) {
    const opts = options || {};
    this.sessionService = opts.sessionService;
    this.promptTimeoutMs = opts.promptTimeoutMs || 120000;
    this.runtimeStaleMs = opts.runtimeStaleMs || 10000;
    this.onSessionEnrolled = opts.onSessionEnrolled || null;
    this.runtimes = new Map();
    this.pending = new Map();
    this.watchers = new Map();
  }

  setOnSessionEnrolled(callback) {
    this.onSessionEnrolled = callback;
  }

  register(input) {
    const data = input || {};
    const runtimeId = requireString(data.runtimeId, 'runtimeId');
    const sessionId = requireString(data.sessionId, 'sessionId');
    const cwd = requireString(data.cwd, 'cwd');
    const now = Date.now();

    let runtime = this.runtimes.get(runtimeId);
    if (!runtime) {
      runtime = { runtimeId, queue: [], currentSessionId: sessionId, cwd, lastSeenAt: now };
      this.runtimes.set(runtimeId, runtime);
    }
    runtime.currentSessionId = sessionId;
    runtime.cwd = cwd;
    runtime.opencodeVersion = data.opencodeVersion || runtime.opencodeVersion || '';
    runtime.lastSeenAt = now;

    let session = this._findSession(runtimeId, sessionId);
    const agentRef = {
      opencodeSessionId: sessionId,
      transport: 'tui-bridge',
      runtimeId,
    };
    if (!session) {
      session = this.sessionService.createSession({
        agent: 'opencode',
        cwd,
        agentRef,
      });
    } else {
      if (session.cwd !== cwd) this.sessionService.updateSessionField(session.id, 'cwd', cwd);
      if (!sameBridgeRef(session.agentRef, agentRef)) {
        this.sessionService.updateSessionField(session.id, 'agentRef', agentRef);
      }
    }

    let routeKey = this.sessionService.getRouteForSession(session.id);
    if (!routeKey) {
      routeKey = findRouteKeyByCwd({ sessionService: this.sessionService }, cwd);
      if (routeKey) this.sessionService.addSessionToRoute(routeKey, session.id, cwd);
    }
    if (routeKey) this.sessionService.setFocus(routeKey, session.id);

    runtime.walkerSessionId = session.id;
    if (typeof this.onSessionEnrolled === 'function') {
      try {
        this.onSessionEnrolled({ sessionId: session.id, routeKey, transport: 'tui-bridge' });
      } catch (err) {
        logger.warn('tui bridge enrollment callback failed', { sessionId: session.id, error: err.message });
      }
    }

    logger.info('tui runtime registered', { runtimeId, opencodeSessionId: sessionId, walkerSessionId: session.id, routeKey });
    return { sessionId: session.id, routeKey };
  }

  poll(input) {
    const data = input || {};
    const runtimeId = requireString(data.runtimeId, 'runtimeId');
    const sessionId = requireString(data.sessionId, 'sessionId');
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) throw new Error('unknown TUI runtime: ' + runtimeId);
    runtime.lastSeenAt = Date.now();
    if (runtime.currentSessionId !== sessionId) return null;
    return runtime.queue.shift() || null;
  }

  prompt(sessionRef, text, options) {
    const ref = this._validateRef(sessionRef);
    const runtime = this.runtimes.get(ref.runtimeId);
    if (!runtime) return Promise.reject(new Error('OpenCode TUI runtime is not connected'));
    if (Date.now() - runtime.lastSeenAt > this.runtimeStaleMs) {
      return Promise.reject(new Error('OpenCode TUI runtime connection is stale'));
    }
    if (runtime.currentSessionId !== ref.opencodeSessionId) {
      return Promise.reject(new Error('OpenCode TUI current session has changed'));
    }

    const deliveryId = createId('del_');
    const delivery = {
      deliveryId,
      sessionId: ref.opencodeSessionId,
      text: String(text || ''),
      model: options && options.model,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(deliveryId);
        reject(new Error('OpenCode TUI bridge prompt timed out after ' + this.promptTimeoutMs + 'ms'));
      }, this.promptTimeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(deliveryId, {
        runtimeId: ref.runtimeId,
        sessionId: ref.opencodeSessionId,
        resolve,
        reject,
        timer,
      });
      runtime.queue.push(delivery);
    });
  }

  reportEvents(input) {
    const data = input || {};
    const runtimeId = requireString(data.runtimeId, 'runtimeId');
    const sessionId = requireString(data.sessionId, 'sessionId');
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) throw new Error('unknown TUI runtime: ' + runtimeId);
    runtime.lastSeenAt = Date.now();
    const events = normalizeEvents(data.events);

    if (data.deliveryId) {
      const pending = this.pending.get(data.deliveryId);
      if (!pending || pending.runtimeId !== runtimeId || pending.sessionId !== sessionId) {
        throw new Error('unknown TUI delivery: ' + data.deliveryId);
      }
      clearTimeout(pending.timer);
      this.pending.delete(data.deliveryId);
      if (data.error) pending.reject(new Error(errorMessage(data.error)));
      else pending.resolve(events);
      return { delivered: true };
    }

    const handlers = this.watchers.get(watchKey(runtimeId, sessionId));
    if (!handlers) return { delivered: false };
    if (data.error) {
      for (const handler of handlers) {
        if (handler && handler.onError) handler.onError(new Error(errorMessage(data.error)));
      }
      return { delivered: true };
    }
    for (const event of events) {
      for (const handler of handlers) {
        if (handler && handler.onEvent) handler.onEvent(event);
      }
    }
    return { delivered: true };
  }

  watchSession(sessionRef, handlers) {
    const ref = this._validateRef(sessionRef);
    const key = watchKey(ref.runtimeId, ref.opencodeSessionId);
    let set = this.watchers.get(key);
    if (!set) {
      set = new Set();
      this.watchers.set(key, set);
    }
    set.add(handlers || {});
    return () => {
      set.delete(handlers || {});
      if (set.size === 0) this.watchers.delete(key);
    };
  }

  stop(sessionRef) {
    return this.cancel(sessionRef);
  }

  cancel(sessionRef) {
    const ref = this._validateRef(sessionRef);
    for (const [deliveryId, pending] of this.pending) {
      if (pending.runtimeId !== ref.runtimeId || pending.sessionId !== ref.opencodeSessionId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error('OpenCode TUI bridge prompt cancelled'));
      this.pending.delete(deliveryId);
    }
    const runtime = this.runtimes.get(ref.runtimeId);
    if (runtime) runtime.queue = runtime.queue.filter((item) => item.sessionId !== ref.opencodeSessionId);
  }

  delete(sessionRef) {
    this.cancel(sessionRef);
  }

  dispose(input) {
    const runtimeId = input && input.runtimeId;
    if (!runtimeId) return;
    const runtime = this.runtimes.get(runtimeId);
    if (runtime && runtime.currentSessionId) {
      this.cancel({ runtimeId, opencodeSessionId: runtime.currentSessionId, transport: 'tui-bridge' });
    }
    this.runtimes.delete(runtimeId);
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('OpenCode TUI bridge closed'));
    }
    this.pending.clear();
    this.watchers.clear();
    this.runtimes.clear();
  }

  _findSession(runtimeId, opencodeSessionId) {
    return this.sessionService.listSessions().find((session) => {
      const ref = session && session.agentRef;
      return ref && ref.transport === 'tui-bridge'
        && ref.runtimeId === runtimeId
        && ref.opencodeSessionId === opencodeSessionId;
    }) || null;
  }

  _validateRef(sessionRef) {
    if (!sessionRef || sessionRef.transport !== 'tui-bridge') {
      throw new Error('tui bridge requires transport=tui-bridge');
    }
    requireString(sessionRef.runtimeId, 'runtimeId');
    requireString(sessionRef.opencodeSessionId, 'opencodeSessionId');
    return sessionRef;
  }
}

function normalizeEvents(events) {
  if (!Array.isArray(events)) return [];
  const allowed = new Set([
    AgentEvent.TYPE_TEXT,
    AgentEvent.TYPE_REASONING,
    AgentEvent.TYPE_TOOL_USE,
    AgentEvent.TYPE_ERROR,
    AgentEvent.TYPE_STATUS,
    AgentEvent.TYPE_DONE,
  ]);
  return events
    .filter((event) => event && allowed.has(event.type))
    .map((event) => event instanceof AgentEvent ? event : new AgentEvent(event.type, event.data || {}));
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('missing ' + name);
  return value.trim();
}

function sameBridgeRef(a, b) {
  return a && a.transport === b.transport && a.runtimeId === b.runtimeId && a.opencodeSessionId === b.opencodeSessionId;
}

function watchKey(runtimeId, sessionId) {
  return runtimeId + ':' + sessionId;
}

function errorMessage(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.message === 'string') return value.message;
  return 'OpenCode TUI bridge error';
}

module.exports = { OpencodeTuiBridge };
