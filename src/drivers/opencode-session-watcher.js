'use strict';

const { AgentEvent } = require('./agent-driver');
const { createLogger } = require('../core/logger');
const { mapSSEEvent, extractMessageId } = require('./opencode-sse-adapter');

const logger = createLogger('opencode-session-watcher');

class OpencodeSessionWatcher {
  constructor(options) {
    this.sseClient = options.sseClient;
    this.buildUrl = options.buildUrl;
    this.watchTimeoutMs = options.watchTimeoutMs || 300000;
    this.pollIntervalMs = options.pollIntervalMs || 3000;
    this.getSessionMessages = options.getSessionMessages;

    this.watchers = new Map();
    this.suspendedWatches = new Set();
    this._pollTimers = null;
    this._lastPolledMessageId = null;
  }

  watch(sessionRef, handlers) {
    if (!sessionRef || !sessionRef.opencodeSessionId) {
      throw new Error('watchSession requires sessionRef with opencodeSessionId');
    }
    const sessionId = sessionRef.opencodeSessionId;
    if (this.watchers.has(sessionId)) return this.watchers.get(sessionId).stop;

    const controller = new AbortController();
    const sseUrl = this.buildUrl('/event', { directory: sessionRef.cwd }, sessionRef);
    logger.info('opencode watchSession starting', { sessionId, sseUrl, cwd: sessionRef.cwd });

    let watchTimer = null;
    const resetWatchTimer = () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        logger.info('opencode watch timeout, aborting', { sessionId });
        controller.abort();
      }, this.watchTimeoutMs);
      if (watchTimer.unref) watchTimer.unref();
    };
    resetWatchTimer();

    const watcher = {
      stop: () => {
        if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
        controller.abort();
        if (this._pollTimers && this._pollTimers.has(sessionId)) {
          clearInterval(this._pollTimers.get(sessionId));
          this._pollTimers.delete(sessionId);
        }
        this.watchers.delete(sessionId);
      },
      _handlers: handlers,
      _signal: controller.signal,
    };
    this.watchers.set(sessionId, watcher);
    if (!this._pollTimers) this._pollTimers = new Map();
    if (!this._lastPolledMessageId) this._lastPolledMessageId = new Map();

    this.sseClient.connect(sseUrl, {
      signal: controller.signal,
      collectEvents: false,
      onOpen: () => logger.info('opencode session watch opened', { sessionId, sseUrl }),
      onEvent: (raw) => {
        resetWatchTimer();
        if (this.suspendedWatches.has(sessionId)) return;
        const event = mapSSEEvent(raw, sessionId);
        if (event && handlers && handlers.onEvent) {
          if (event.type === AgentEvent.TYPE_TEXT) {
            this._markSSEMessagePolled(raw, sessionId);
          }
          handlers.onEvent(event, raw);
        }
      },
    }).catch((err) => {
      if (!controller.signal.aborted) {
        logger.warn('opencode session watch failed', { sessionId, error: err.message });
        if (handlers && handlers.onError) handlers.onError(err);
      }
    }).finally(() => {
      if (this.watchers.get(sessionId) === watcher) watcher.stop();
    });

    this._startMessagePolling(sessionRef, handlers, controller.signal);

    return watcher.stop;
  }

  suspend(sessionRef) {
    const sessionId = sessionRef && sessionRef.opencodeSessionId;
    if (sessionId) {
      this.suspendedWatches.add(sessionId);
      this._pausePolling(sessionId);
    }
  }

  resume(sessionRef) {
    const sessionId = sessionRef && sessionRef.opencodeSessionId;
    if (sessionId) {
      this.suspendedWatches.delete(sessionId);
      this._resumePolling(sessionRef);
    }
  }

  _pausePolling(sessionId) {
    if (this._pollTimers && this._pollTimers.has(sessionId)) {
      clearInterval(this._pollTimers.get(sessionId));
      this._pollTimers.delete(sessionId);
    }
  }

  _resumePolling(sessionRef) {
    const sessionId = sessionRef.opencodeSessionId;
    if (!sessionId || !this.watchers.has(sessionId)) return;
    if (this._pollTimers && this._pollTimers.has(sessionId)) return;
    const watcher = this.watchers.get(sessionId);
    this._startMessagePolling(sessionRef, watcher._handlers, watcher._signal);
  }

  stopWatch(sessionId) {
    const watcher = this.watchers.get(sessionId);
    if (watcher) watcher.stop();
  }

  clearAll() {
    for (const [sessionId] of this.watchers) {
      this.stopWatch(sessionId);
    }
    this.suspendedWatches.clear();
  }

  hasActiveWatch(sessionId) {
    return this.watchers.has(sessionId);
  }

  getLastPolledMessageId(sessionId) {
    return this._lastPolledMessageId ? this._lastPolledMessageId.get(sessionId) : undefined;
  }

  setLastPolledMessageId(sessionId, messageId) {
    if (!this._lastPolledMessageId) this._lastPolledMessageId = new Map();
    if (messageId) this._lastPolledMessageId.set(sessionId, messageId);
  }

  hasLastPolledMessageId(sessionId) {
    return this._lastPolledMessageId && this._lastPolledMessageId.has(sessionId);
  }

  _markSSEMessagePolled(raw, sessionId) {
    if (!this._lastPolledMessageId) this._lastPolledMessageId = new Map();
    const messageId = extractMessageId(raw, sessionId);
    if (messageId) this._lastPolledMessageId.set(sessionId, messageId);
  }

  _startMessagePolling(sessionRef, handlers, signal) {
    const sessionId = sessionRef.opencodeSessionId;
    const pollIntervalMs = this.pollIntervalMs;
    const self = this;
    let polling = false;

    const poll = async () => {
      if (signal.aborted) return;
      if (self.suspendedWatches.has(sessionId)) return;
      if (polling) return;
      polling = true;
      try {
        const messages = await self.getSessionMessages(sessionRef);
        if (signal.aborted) return;
        const lastKnownId = self._lastPolledMessageId.get(sessionId);
        let newMessages = [];
        if (lastKnownId) {
          const knownIdx = messages.findIndex((m) => (m.info && m.info.id) === lastKnownId || m.id === lastKnownId);
          if (knownIdx >= 0) newMessages = messages.slice(knownIdx + 1);
          else newMessages = messages;
        } else {
          if (messages.length > 0) {
            const completed = messages.filter((m) => {
              const role = m.info ? m.info.role : m.role;
              const comp = m.info && m.info.time && m.info.time.completed;
              return role === 'assistant' && comp;
            });
            if (completed.length > 0) {
              for (const msg of completed) {
                if (self.suspendedWatches.has(sessionId)) return;
                const parts = msg.parts || [];
                for (const part of parts) {
                  if (part.type === 'text' && part.text) {
                    if (handlers && handlers.onEvent) {
                      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: part.text }));
                    }
                  }
                }
              }
              if (handlers && handlers.onEvent) {
                handlers.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));
              }
              const lastComp = completed[completed.length - 1];
              self._lastPolledMessageId.set(sessionId, lastComp.info ? lastComp.info.id : lastComp.id);
            }
            // 只有 pending（无 completed）时，不推进游标，保留为空，
            // 让后续 poll 能识别 pending → completed 的状态变化并推送
          }
          return;
        }
        const assistantMessages = newMessages.filter((m) => {
          const role = m.info ? m.info.role : m.role;
          return role === 'assistant';
        });
        const completedMessages = [];
        const pendingMessages = [];
        for (const msg of assistantMessages) {
          const completed = msg.info && msg.info.time && msg.info.time.completed;
          if (completed) completedMessages.push(msg);
          else pendingMessages.push(msg);
        }
        if (completedMessages.length > 0) {
          for (const msg of completedMessages) {
            if (self.suspendedWatches.has(sessionId)) return;
            const parts = msg.parts || [];
            const msgId = msg.info ? msg.info.id : msg.id;
            for (const part of parts) {
              if (part.type === 'text' && part.text) {
                if (handlers && handlers.onEvent) {
                  handlers.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: part.text }));
                }
              }
            }
            self._lastPolledMessageId.set(sessionId, msgId);
          }
          if (handlers && handlers.onEvent) {
            handlers.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));
          }
        }
        if (pendingMessages.length > 0) {
          // 不推进游标到 pending 消息，保留在 baseline 处
          // pending 同 ID 原地 completed 时会在后续 poll 中被 foundBaseline 逻辑找到
        } else if (completedMessages.length === 0 && newMessages.length > 0) {
          // 所有 newMessages 都不是 completed assistant，不推进游标
        }
      } catch (err) {
        if (!signal.aborted) {
          logger.warn('opencode poll failed', { sessionId, error: err.message });
        }
      } finally {
        polling = false;
      }
    };

    poll();
    const timer = setInterval(poll, pollIntervalMs);
    if (timer.unref) timer.unref();
    this._pollTimers.set(sessionId, timer);
  }
}

module.exports = { OpencodeSessionWatcher };
