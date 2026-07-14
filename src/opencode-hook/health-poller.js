'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('health-poller');

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_FAILURE_THRESHOLD = 2;

function createHealthPoller(options) {
  const opts = options || {};
  const sessionService = opts.sessionService;
  const driverRegistry = opts.driverRegistry;
  const dispatcher = opts.dispatcher;
  const pollIntervalMs = opts.pollIntervalMs > 0 ? opts.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
  const exitAction = opts.exitAction || 'cancel';
  const httpClient = opts.httpClient;
  const failureThreshold = opts.failureThreshold > 0 ? opts.failureThreshold : DEFAULT_FAILURE_THRESHOLD;

  const trackers = new Map();

  function start() {}

  function stop() {
    for (const sessionId of trackers.keys()) {
      _clearTimer(sessionId);
    }
    trackers.clear();
  }

  function track(sessionId, agentRef) {
    if (!sessionId || !agentRef) return;
    if (trackers.has(sessionId)) {
      const existing = trackers.get(sessionId);
      existing.agentRef = agentRef;
      logger.info('session tracked, agentRef updated', { sessionId });
      return;
    }
    const entry = {
      agentRef,
      failureCount: 0,
      timer: null,
      polling: false,
    };
    trackers.set(sessionId, entry);
    const timer = setInterval(() => {
      _poll(sessionId).catch((err) => {
        logger.warn('poll cycle error', { sessionId, err: err && err.message ? err.message : String(err) });
      });
    }, pollIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    entry.timer = timer;
    logger.info('session tracked', { sessionId, pollIntervalMs });
  }

  function untrack(sessionId) {
    _clearTimer(sessionId);
    trackers.delete(sessionId);
  }

  function getTrackedSessions() {
    return Array.from(trackers.keys());
  }

  function _clearTimer(sessionId) {
    const entry = trackers.get(sessionId);
    if (entry && entry.timer) {
      try { clearInterval(entry.timer); } catch (_) {}
      entry.timer = null;
    }
  }

  async function _poll(sessionId) {
    const entry = trackers.get(sessionId);
    if (!entry || entry.polling) return;
    entry.polling = true;
    try {
      const ok = await _checkHealth(entry.agentRef);
      if (ok) {
        entry.failureCount = 0;
        return;
      }
      entry.failureCount += 1;
      logger.info('health check failed', { sessionId, failureCount: entry.failureCount });
      if (entry.failureCount >= failureThreshold) {
        logger.warn('session detached, handling', { sessionId, failureCount: entry.failureCount });
        await _handleDetached(sessionId, entry);
      }
    } finally {
      if (entry) entry.polling = false;
    }
  }

  async function _checkHealth(agentRef) {
    const serverUrl = (agentRef && agentRef.serverUrl) || '';
    if (!serverUrl) return false;
    const url = serverUrl.replace(/\/+$/, '') + '/global/health';
    try {
      const resp = await httpClient.request('GET', url, null);
      return !!(resp && resp.status >= 200 && resp.status < 300);
    } catch (err) {
      logger.debug('health check error', { url, err: err && err.message ? err.message : String(err) });
      return false;
    }
  }

  async function _handleDetached(sessionId, entry) {
    try {
      const session = sessionService.getSession(sessionId);
      const routeKey = sessionService.getRouteForSession(sessionId);

      if (exitAction === 'cancel' && session && dispatcher) {
        const turnState = typeof dispatcher.getTurnState === 'function'
          ? dispatcher.getTurnState(sessionId) : null;
        if (turnState && !turnState.cancelled) {
          try {
            await dispatcher.cancelTurnBySessionId(sessionId, 'opencode-detached');
          } catch (err) {
            logger.warn('cancel turn failed on detach', { sessionId, err: err && err.message ? err.message : String(err) });
          }
        }
      }

      if (routeKey && sessionService.removeSessionFromRoute) {
        try {
          sessionService.removeSessionFromRoute(routeKey, sessionId);
        } catch (err) {
          logger.warn('remove session from route failed', { sessionId, routeKey, err: err && err.message ? err.message : String(err) });
        }
      }

      if (dispatcher && typeof dispatcher.stopSessionWatch === 'function') {
        try {
          dispatcher.stopSessionWatch(sessionId);
        } catch (err) {
          logger.warn('stop session watch failed', { sessionId, err: err && err.message ? err.message : String(err) });
        }
      }

      untrack(sessionId);
      logger.info('session detached handled', { sessionId, routeKey });
    } catch (err) {
      logger.error('handle detached failed', { sessionId, err });
    }
  }

  return { start, stop, track, untrack, getTrackedSessions };
}

module.exports = { createHealthPoller };
