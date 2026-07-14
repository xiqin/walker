'use strict';

const { createLogger } = require('./logger');

const logger = createLogger('message-dedup');

class MessageDedup {
  constructor(options) {
    this.windowMs = options.windowMs != null ? options.windowMs : 300000;
    this.entries = {};
    this._store = options.store || null;
    this._staleThresholdMs = options.staleThresholdMs || this.windowMs;
    this._cleanupThreshold = options.cleanupThreshold || 200;
    this._lastCleanup = 0;
    this._persistTimer = null;
    this._persistDirty = false;
    if (this._store) {
      const stored = this._store.read();
      if (stored && typeof stored === 'object') {
        this.entries = stored;
      }
    }
  }

  isDuplicate(key, createTime) {
    const now = Date.now();

    if (createTime != null && this._staleThresholdMs > 0) {
      const elapsed = now - createTime;
      if (elapsed > this._staleThresholdMs) {
        logger.info('stale message rejected', { key, elapsedMs: elapsed });
        return true;
      }
    }

    if (this.size() >= this._cleanupThreshold || now - this._lastCleanup > this.windowMs) {
      this._cleanup(now);
    }

    const existing = this.entries[key];
    if (existing) {
      if (now - existing > this.windowMs) {
        delete this.entries[key];
        this._persist();
      } else {
        logger.info('duplicate message detected', { key });
        return true;
      }
    }

    this.entries[key] = now;
    this._persist();
    return false;
  }

  size() {
    return Object.keys(this.entries).length;
  }

  _cleanup(now) {
    this._lastCleanup = now;
    let dirty = false;
    for (const key of Object.keys(this.entries)) {
      if (now - this.entries[key] > this.windowMs) {
        delete this.entries[key];
        dirty = true;
      }
    }
    if (dirty) this._persist();
  }

  _persist() {
    if (!this._store) return;
    this._persistDirty = true;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      if (!this._persistDirty) return;
      this._persistDirty = false;
      this._store.update((data) => {
        Object.assign(data, this.entries);
        for (const key of Object.keys(data)) {
          if (!this.entries[key]) {
            delete data[key];
          }
        }
      });
    }, 1000);
    if (this._persistTimer && typeof this._persistTimer.unref === 'function') {
      this._persistTimer.unref();
    }
  }
}

module.exports = { MessageDedup };
