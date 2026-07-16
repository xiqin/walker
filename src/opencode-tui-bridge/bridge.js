'use strict';

const { createId } = require('../core/id');
const { createLogger } = require('../core/logger');
const { AgentEvent } = require('../drivers/agent-driver');
const { findRouteKeyByCwd } = require('../opencode-hook/receiver');

const logger = createLogger('opencode-tui-bridge');

const DELIVERY_TYPE_PROMPT = 'prompt';
const DELIVERY_TYPE_CLEAR = 'clear';
const CLEAR_PENDING_PREFIX = 'clr_';

class OpencodeTuiBridge {
  constructor(options) {
    const opts = options || {};
    this.sessionService = opts.sessionService;
    this.leaseTimeoutMs = opts.leaseTimeoutMs ?? 90000;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30000;
    this.runtimeStaleMs = opts.runtimeStaleMs || 10000;
    this.tombstoneCapacity = opts.tombstoneCapacity ?? 100;
    this.tombstoneTtlMs = opts.tombstoneTtlMs ?? 300000;
    this.promptTimeoutMs = opts.promptTimeoutMs || 120000;
    this.onSessionEnrolled = opts.onSessionEnrolled || null;
    this.runtimes = new Map();
    this.pending = new Map();
    this._tombstones = new Map();
    this.watchers = new Map();
    this._clearPending = new Map();
    this._lastClearDeliveryId = null;
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

    const controlDeliveryId = data.controlDeliveryId;
    if (controlDeliveryId) {
      return this._registerClearAssociated({
        runtimeId, sessionId, cwd, controlDeliveryId,
        opencodeVersion: data.opencodeVersion,
      });
    }

    let runtime = this.runtimes.get(runtimeId);
    if (!runtime) {
      runtime = { runtimeId, queue: [], currentSessionId: sessionId, cwd, lastSeenAt: now };
      this.runtimes.set(runtimeId, runtime);
    }
    runtime.currentSessionId = sessionId;
    runtime.cwd = cwd;
    runtime.opencodeVersion = data.opencodeVersion || runtime.opencodeVersion || '';
    runtime.bridgeProtocolVersion = Number(data.bridgeProtocolVersion) || 0;
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

  _registerClearAssociated(input) {
    const { runtimeId, sessionId, cwd, controlDeliveryId, opencodeVersion } = input;
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) {
      throw new Error('unknown TUI runtime for clear register: ' + runtimeId);
    }
    const clearPending = this._clearPending.get(controlDeliveryId);
    if (!clearPending) {
      throw new Error('unknown or expired controlDeliveryId: ' + controlDeliveryId);
    }
    if (clearPending.runtimeId !== runtimeId) {
      throw new Error('controlDeliveryId runtime mismatch: ' + controlDeliveryId);
    }
    if (clearPending.newSessionId && clearPending.newSessionId !== sessionId) {
      throw new Error('controlDeliveryId session mismatch: ' + controlDeliveryId);
    }

    clearPending.newSessionId = sessionId;
    clearPending.registeredCwd = cwd;
    clearPending.registeredOpencodeVersion = opencodeVersion || '';
    clearPending.registerCompleted = true;
    runtime.lastSeenAt = Date.now();

    logger.info('clear associated register staged', {
      runtimeId, opencodeSessionId: sessionId, controlDeliveryId,
    });

    this._tryCompleteClear(controlDeliveryId);
    return { staged: true, controlDeliveryId };
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
      type: DELIVERY_TYPE_PROMPT,
      sessionId: ref.opencodeSessionId,
      text: String(text || ''),
      model: options && options.model,
    };
    const signal = options && options.signal;

    return new Promise((resolve, reject) => {
      const pendingEntry = {
        runtimeId: ref.runtimeId,
        sessionId: ref.opencodeSessionId,
        state: 'queued',
        resolve,
        reject,
        timer: null,
        leaseStartedAt: null,
        cancelReason: null,
      };

      const onAbort = () => {
        const existing = this.pending.get(deliveryId);
        if (!existing || existing.state === 'completed') return;
        existing.cancelReason = 'user_cancelled';
        clearTimeout(existing.timer);
        existing.timer = null;
        this.pending.delete(deliveryId);
        this._addTombstone(deliveryId, ref.runtimeId, ref.opencodeSessionId, 'cancelled');
        reject(new Error('OpenCode TUI bridge prompt cancelled'));
      };

      if (signal) {
        if (signal.aborted) {
          this._addTombstone(deliveryId, ref.runtimeId, ref.opencodeSessionId, 'cancelled');
          reject(new Error('OpenCode TUI bridge prompt cancelled'));
          return;
        }
        pendingEntry._onAbort = onAbort;
        pendingEntry._signal = signal;
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(deliveryId, pendingEntry);
      runtime.queue.push(delivery);
    });
  }

  clearSession(sessionRef) {
    let ref;
    try {
      ref = this._validateRef(sessionRef);
    } catch (err) {
      return Promise.reject(err);
    }
    const runtime = this.runtimes.get(ref.runtimeId);
    if (!runtime) {
      return Promise.reject(new Error('OpenCode TUI runtime is not connected'));
    }
    if (Date.now() - runtime.lastSeenAt > this.runtimeStaleMs) {
      return Promise.reject(new Error('OpenCode TUI runtime connection is stale'));
    }
    if (runtime.currentSessionId !== ref.opencodeSessionId) {
      return Promise.reject(new Error('OpenCode TUI current session has changed'));
    }
    if ((runtime.bridgeProtocolVersion || 0) < 2) {
      return Promise.reject(new Error('OpenCode TUI plugin does not support /clear. Restart the OpenCode TUI to load the updated Walker plugin.'));
    }

    for (const pending of this._clearPending.values()) {
      if (pending.runtimeId === ref.runtimeId) {
        return Promise.reject(new Error('OpenCode TUI runtime already has a clear in flight'));
      }
    }

    const oldWalkerSession = this._findSession(ref.runtimeId, ref.opencodeSessionId);
    if (!oldWalkerSession) {
      return Promise.reject(new Error('OpenCode TUI session not enrolled: ' + ref.opencodeSessionId));
    }
    const oldRouteKey = this.sessionService.getRouteForSession(oldWalkerSession.id);
    const oldModel = oldWalkerSession.model || null;

    const deliveryId = createId('del_');
    this._lastClearDeliveryId = deliveryId;
    const delivery = {
      deliveryId,
      type: DELIVERY_TYPE_CLEAR,
      sessionId: ref.opencodeSessionId,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._failClear(deliveryId, new Error('OpenCode TUI bridge clear timed out after ' + this.promptTimeoutMs + 'ms'));
      }, this.promptTimeoutMs);
      if (timer.unref) timer.unref();
      this._clearPending.set(deliveryId, {
        deliveryId,
        runtimeId: ref.runtimeId,
        oldSessionId: ref.opencodeSessionId,
        oldWalkerSessionId: oldWalkerSession.id,
        routeKey: oldRouteKey,
        oldModel,
        newSessionId: null,
        registeredCwd: null,
        registeredOpencodeVersion: '',
        registerCompleted: false,
        controlCompleted: false,
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
      const clearPending = this._clearPending.get(data.deliveryId);
      if (clearPending) {
        return this._handleClearControlResult({
          clearPending, runtimeId, sessionId, data,
        });
      }
      const deliveryState = data.deliveryState;
      if (deliveryState === 'accepted') {
        return this._handleAccepted(data.deliveryId, runtimeId, sessionId);
      }
      if (deliveryState === 'heartbeat') {
        return this._handleHeartbeat(data.deliveryId, runtimeId, sessionId);
      }
      return this._handleFinal(data.deliveryId, runtimeId, sessionId, data, events);
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

  _handleAccepted(deliveryId, runtimeId, sessionId) {
    const pending = this.pending.get(deliveryId);
    if (!pending || pending.runtimeId !== runtimeId || pending.sessionId !== sessionId) {
      throw new Error('unknown TUI delivery: ' + deliveryId);
    }
    if (pending.state !== 'queued') {
      throw new Error('delivery ' + deliveryId + ' cannot accept from state ' + pending.state);
    }
    pending.state = 'leased';
    pending.leaseStartedAt = Date.now();
    const timer = setTimeout(() => {
      this._loseLease(deliveryId, 'TUI_RUNTIME_DISCONNECTED');
    }, this.leaseTimeoutMs);
    if (timer.unref) timer.unref();
    pending.timer = timer;
    return { delivered: true };
  }

  _handleHeartbeat(deliveryId, runtimeId, sessionId) {
    const pending = this.pending.get(deliveryId);
    if (!pending || pending.runtimeId !== runtimeId || pending.sessionId !== sessionId) {
      throw new Error('unknown TUI delivery: ' + deliveryId);
    }
    if (pending.state !== 'leased') {
      throw new Error('delivery ' + deliveryId + ' cannot heartbeat from state ' + pending.state);
    }
    clearTimeout(pending.timer);
    const timer = setTimeout(() => {
      this._loseLease(deliveryId, 'TUI_RUNTIME_DISCONNECTED');
    }, this.leaseTimeoutMs);
    if (timer.unref) timer.unref();
    pending.timer = timer;
    return { delivered: true };
  }

  _handleFinal(deliveryId, runtimeId, sessionId, data, events) {
    const pending = this.pending.get(deliveryId);
    if (pending && pending.runtimeId === runtimeId && pending.sessionId === sessionId) {
      if (pending.state === 'queued' || pending.state === 'leased') {
        clearTimeout(pending.timer);
        pending.timer = null;
        this._removeAbortListener(pending);
        pending.state = 'completed';
        this.pending.delete(deliveryId);
        this._addTombstone(deliveryId, pending.runtimeId, pending.sessionId, 'completed');
        if (data.error) pending.reject(new Error(errorMessage(data.error)));
        else pending.resolve(events);
        return { delivered: true };
      }
    }

    const tombstone = this._tombstones.get(deliveryId);
    if (tombstone) {
      if (tombstone.reason === 'completed') {
        return { delivered: true, duplicate: true };
      }
      if (tombstone.reason === 'transport_lost') {
        if (tombstone.resolvedAt) {
          return { delivered: true, duplicate: true };
        }
        const handlers = this.watchers.get(watchKey(runtimeId, sessionId));
        if (handlers && !data.error) {
          for (const event of events) {
            for (const handler of handlers) {
              if (handler && handler.onEvent) handler.onEvent(event);
            }
          }
        }
        tombstone.resolvedAt = Date.now();
        return { delivered: true, recovered: true };
      }
      if (tombstone.reason === 'cancelled' || tombstone.reason === 'deadline') {
        return { delivered: true, suppressed: true };
      }
    }

    throw new Error('unknown TUI delivery: ' + deliveryId);
  }

  _loseLease(deliveryId, errorCode) {
    const pending = this.pending.get(deliveryId);
    if (!pending) return;
    if (pending.state !== 'leased') return;
    clearTimeout(pending.timer);
    pending.timer = null;
    this._removeAbortListener(pending);
    this.pending.delete(deliveryId);
    this._addTombstone(deliveryId, pending.runtimeId, pending.sessionId, 'transport_lost');
    pending.reject(new Error(errorCode || 'TUI_LEASE_LOST'));
  }

  _addTombstone(deliveryId, runtimeId, sessionId, reason) {
    this._tombstones.set(deliveryId, {
      deliveryId,
      runtimeId,
      sessionId,
      reason,
      createdAt: Date.now(),
      resolvedAt: null,
    });
    this._evictTombstones();
  }

  _evictTombstones() {
    const now = Date.now();
    for (const [id, ts] of this._tombstones) {
      if (now - ts.createdAt > this.tombstoneTtlMs) {
        this._tombstones.delete(id);
      }
    }
    while (this._tombstones.size > this.tombstoneCapacity) {
      let oldest = null;
      for (const [id, ts] of this._tombstones) {
        if (!oldest || ts.createdAt < this._tombstones.get(oldest).createdAt) {
          oldest = id;
        }
      }
      if (oldest) this._tombstones.delete(oldest);
      else break;
    }
  }

  _removeAbortListener(pending) {
    if (pending._onAbort && pending._signal) {
      pending._signal.removeEventListener('abort', pending._onAbort);
      pending._onAbort = null;
      pending._signal = null;
    }
  }

  _handleClearControlResult(input) {
    const { clearPending, runtimeId, sessionId, data } = input;
    if (clearPending.runtimeId !== runtimeId) {
      throw new Error('clear control result runtime mismatch: ' + data.deliveryId);
    }
    if (clearPending.oldSessionId !== sessionId) {
      throw new Error('clear control result session mismatch: ' + data.deliveryId);
    }
    if (data.error) {
      this._failClear(data.deliveryId, new Error(errorMessage(data.error)));
      return { delivered: true };
    }
    const control = data.control || {};
    if (control.type !== DELIVERY_TYPE_CLEAR) {
      throw new Error('unexpected control type for clear delivery: ' + control.type);
    }
    const newSessionId = control.newSessionId;
    if (!newSessionId || typeof newSessionId !== 'string') {
      this._failClear(data.deliveryId, new Error('clear control result missing newSessionId'));
      return { delivered: true };
    }
    if (clearPending.newSessionId && clearPending.newSessionId !== newSessionId) {
      this._failClear(data.deliveryId, new Error('clear control newSessionId mismatch'));
      return { delivered: true };
    }
    clearPending.newSessionId = newSessionId;
    clearPending.controlCompleted = true;
    this._tryCompleteClear(data.deliveryId);
    return { delivered: true };
  }

  _tryCompleteClear(deliveryId) {
    const clearPending = this._clearPending.get(deliveryId);
    if (!clearPending) return;
    if (!clearPending.registerCompleted || !clearPending.controlCompleted) return;
    if (!clearPending.newSessionId) {
      this._failClear(deliveryId, new Error('clear completed without newSessionId'));
      return;
    }

    clearTimeout(clearPending.timer);
    this._clearPending.delete(deliveryId);

    const runtime = this.runtimes.get(clearPending.runtimeId);
    if (!runtime) {
      clearPending.reject(new Error('OpenCode TUI runtime disappeared during clear'));
      return;
    }

    const cwd = clearPending.registeredCwd || runtime.cwd || '';
    const agentRef = {
      opencodeSessionId: clearPending.newSessionId,
      transport: 'tui-bridge',
      runtimeId: clearPending.runtimeId,
    };
    let newWalkerSession = this._findSession(clearPending.runtimeId, clearPending.newSessionId);
    if (!newWalkerSession) {
      const createOpts = {
        agent: 'opencode',
        cwd,
        agentRef,
      };
      if (clearPending.routeKey) createOpts.route = clearPending.routeKey;
      if (clearPending.oldModel) createOpts.model = clearPending.oldModel;
      newWalkerSession = this.sessionService.createSession(createOpts);
    } else {
      if (newWalkerSession.cwd !== cwd) {
        this.sessionService.updateSessionField(newWalkerSession.id, 'cwd', cwd);
      }
      if (!sameBridgeRef(newWalkerSession.agentRef, agentRef)) {
        this.sessionService.updateSessionField(newWalkerSession.id, 'agentRef', agentRef);
      }
      if (clearPending.oldModel && !newWalkerSession.model) {
        this.sessionService.updateSessionField(newWalkerSession.id, 'model', clearPending.oldModel);
      }
    }

    if (clearPending.routeKey) {
      const routeSessions = this.sessionService.listSessionsInRoute(clearPending.routeKey);
      if (!routeSessions.find((s) => s.id === newWalkerSession.id)) {
        this.sessionService.addSessionToRoute(clearPending.routeKey, newWalkerSession.id, cwd);
      }
      this.sessionService.setFocus(clearPending.routeKey, newWalkerSession.id);
    }

    runtime.currentSessionId = clearPending.newSessionId;
    runtime.walkerSessionId = newWalkerSession.id;
    runtime.cwd = cwd;

    if (typeof this.onSessionEnrolled === 'function') {
      try {
        this.onSessionEnrolled({
          sessionId: newWalkerSession.id,
          routeKey: clearPending.routeKey,
          transport: 'tui-bridge',
        });
      } catch (err) {
        logger.warn('tui bridge clear enrollment callback failed', {
          sessionId: newWalkerSession.id, error: err.message,
        });
      }
    }

    const result = {
      runtimeId: clearPending.runtimeId,
      oldSessionId: clearPending.oldSessionId,
      newSessionId: clearPending.newSessionId,
      walkerSessionId: newWalkerSession.id,
    };
    logger.info('clear completed', result);
    clearPending.resolve(result);
  }

  _failClear(deliveryId, err) {
    const clearPending = this._clearPending.get(deliveryId);
    if (!clearPending) return;
    clearTimeout(clearPending.timer);
    this._clearPending.delete(deliveryId);
    clearPending.reject(err);
  }

  hasClearPending(sessionRef) {
    if (!sessionRef || !sessionRef.runtimeId) return false;
    for (const pending of this._clearPending.values()) {
      if (pending.runtimeId === sessionRef.runtimeId) return true;
    }
    return false;
  }

  _failClearsForRuntime(runtimeId, sessionRef, err) {
    for (const [deliveryId, clearPending] of this._clearPending) {
      if (clearPending.runtimeId !== runtimeId) continue;
      if (sessionRef && clearPending.oldSessionId !== sessionRef) continue;
      this._failClear(deliveryId, err);
    }
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
      pending.timer = null;
      this._removeAbortListener(pending);
      pending.cancelReason = 'user_cancelled';
      this.pending.delete(deliveryId);
      this._addTombstone(deliveryId, pending.runtimeId, pending.sessionId, 'cancelled');
      pending.reject(new Error('OpenCode TUI bridge prompt cancelled'));
    }
    const runtime = this.runtimes.get(ref.runtimeId);
    if (runtime) runtime.queue = runtime.queue.filter((item) => item.sessionId !== ref.opencodeSessionId);

    this._failClearsForRuntime(ref.runtimeId, ref.opencodeSessionId, new Error('OpenCode TUI bridge clear cancelled'));
  }

  delete(sessionRef) {
    this.cancel(sessionRef);
  }

  dispose(input) {
    const runtimeId = input && input.runtimeId;
    if (!runtimeId) return;
    for (const [deliveryId, pending] of this.pending) {
      if (pending.runtimeId !== runtimeId) continue;
      clearTimeout(pending.timer);
      pending.timer = null;
      this._removeAbortListener(pending);
      pending.cancelReason = 'runtime_disposed';
      this.pending.delete(deliveryId);
      this._addTombstone(deliveryId, pending.runtimeId, pending.sessionId, 'transport_lost');
      pending.reject(new Error('OpenCode TUI bridge runtime disposed'));
    }
    this._failClearsForRuntime(runtimeId, null, new Error('OpenCode TUI bridge runtime disposed'));
    this.runtimes.delete(runtimeId);
  }

  close() {
    for (const [deliveryId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.timer = null;
      this._removeAbortListener(pending);
      pending.reject(new Error('OpenCode TUI bridge closed'));
      this.pending.delete(deliveryId);
    }
    for (const deliveryId of this._clearPending.keys()) {
      this._failClear(deliveryId, new Error('OpenCode TUI bridge closed'));
    }
    this._tombstones.clear();
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
