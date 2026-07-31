'use strict';

const DISALLOWED_REAL_PLATFORMS = new Set(['telegram', 'slack', 'discord', 'whatsapp']);

class PlatformRegistry {
  constructor() {
    this._drivers = new Map();
    this._states = new Map();
  }

  register(platform, driver) {
    const id = normalizePlatform(platform || driver && driver.platform);
    if (!id) throw new Error('platform is required');
    if (DISALLOWED_REAL_PLATFORMS.has(id)) {
      const error = new Error('real external platform integration is not allowed for ' + id);
      error.code = 'PLATFORM_NOT_ALLOWED';
      throw error;
    }
    if (!driver || typeof driver !== 'object') throw new Error('driver is required');
    for (const method of ['start', 'stop', 'sendMessage', 'updateMessage', 'sendCard', 'uploadAttachment']) {
      if (typeof driver[method] !== 'function') throw new Error('driver missing method: ' + method);
    }
    this._drivers.set(id, driver);
    this._states.set(id, { platform: id, status: 'registered', error: null });
    return driver;
  }

  get(platform) {
    return this._drivers.get(normalizePlatform(platform)) || null;
  }

  list() {
    return Array.from(this._drivers.keys());
  }

  status(platform) {
    if (platform) return this._states.get(normalizePlatform(platform)) || { platform: normalizePlatform(platform), status: 'missing', error: null };
    return Array.from(this._states.values());
  }

  async start(platform) {
    const id = normalizePlatform(platform);
    if (DISALLOWED_REAL_PLATFORMS.has(id)) {
      const error = new Error('real external platform integration is not allowed for ' + id);
      error.code = 'PLATFORM_NOT_ALLOWED';
      throw error;
    }
    const driver = this.get(id);
    if (!driver) throw new Error('platform driver not found: ' + id);
    this._states.set(id, { platform: id, status: 'starting', error: null });
    try {
      const result = await driver.start();
      this._states.set(id, { platform: id, status: 'started', error: null });
      return result;
    } catch (err) {
      this._states.set(id, { platform: id, status: 'error', error: err && err.message ? err.message : String(err) });
      throw err;
    }
  }

  async stop(platform) {
    const id = normalizePlatform(platform);
    const driver = this.get(id);
    if (!driver) return null;
    try {
      const result = await driver.stop();
      this._states.set(id, { platform: id, status: 'stopped', error: null });
      return result;
    } catch (err) {
      this._states.set(id, { platform: id, status: 'error', error: err && err.message ? err.message : String(err) });
      throw err;
    }
  }
}

function normalizePlatform(platform) {
  return String(platform || '').trim().toLowerCase();
}

module.exports = { PlatformRegistry, DISALLOWED_REAL_PLATFORMS };
