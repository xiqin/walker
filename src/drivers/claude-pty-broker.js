'use strict';

const { createLogger } = require('../core/logger');
const { createId } = require('../core/id');
const { createClaudePtyRuntime } = require('./claude-pty-runtime');

const DEFAULT_REPLAY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_QUEUE_LIMIT = 5;

class ClaudePtyBroker {
  constructor(options) {
    const opts = options || {};
    this.command = opts.command || 'kscc';
    this.cwd = opts.cwd;
    this.env = opts.env || {};
    this.ptyFactory = opts.ptyFactory;
    this.idFactory = opts.idFactory || (() => createId('rt_'));
    this.logger = opts.logger || createLogger('claude-pty-broker');
    this.bridgeSidecar = opts.bridgeSidecar || opts.claudeBridge || null;
    this.replayLimitBytes = opts.replayLimitBytes == null ? DEFAULT_REPLAY_LIMIT_BYTES : opts.replayLimitBytes;
    this.queueLimit = opts.queueLimit == null ? DEFAULT_QUEUE_LIMIT : opts.queueLimit;
    this.runtimes = new Map();
  }

  createRuntime(options) {
    const opts = options || {};
    const runtimeId = opts.runtimeId || this.idFactory();
    if (this.runtimes.has(runtimeId)) throw new Error('runtime already exists: ' + runtimeId);
    const record = this._createRecord(runtimeId, opts.claudeSessionId, 1, opts);
    this._spawn(record, this._launchArgs(opts, ['--session-id', opts.claudeSessionId]), opts);
    this.runtimes.set(runtimeId, record);
    this._registerBridgeRuntime(record);
    this._log('info', 'claude pty runtime created', record, { queueDepth: record.pending.size });
    return this._snapshot(record);
  }

  resumeRuntime(options) {
    const opts = options || {};
    const runtimeId = opts.runtimeId || this.idFactory();
    const existing = this.runtimes.get(runtimeId);
    const baselineGeneration = opts.processGeneration || 0;
    const generation = existing ? Math.max(existing.processGeneration, baselineGeneration) + 1 : (baselineGeneration ? baselineGeneration + 1 : 1);
    const record = existing ? this._createRecord(runtimeId, opts.claudeSessionId || existing.claudeSessionId, generation, { ...opts, cwd: opts.cwd || existing.cwd }) : this._createRecord(runtimeId, opts.claudeSessionId, generation, opts);
    if (existing) {
      record.replay = existing.replay;
      record.replayBytes = existing.replayBytes;
      record.subscribers = existing.subscribers;
      record.pending = existing.pending;
    }
    this._spawn(record, this._launchArgs(opts, ['--resume', record.claudeSessionId]), opts);
    if (existing && existing.runtime) existing.runtime.kill('SIGTERM');
    this.runtimes.set(runtimeId, record);
    this._registerBridgeRuntime(record);
    this._log('info', 'claude pty runtime resumed', record, { queueDepth: record.pending.size });
    return this._snapshot(record);
  }

  getRuntime(runtimeId) {
    const record = this.runtimes.get(runtimeId);
    if (record) return this._snapshot(record);
    return this._getBridgeRuntime(runtimeId);
  }

  listRuntimes() {
    return Array.from(this.runtimes.values()).map((record) => this._snapshot(record));
  }

  stopRuntime(runtimeId, reason) {
    const record = this.runtimes.get(runtimeId);
    if (!record) return null;
    if (!record.stopped && record.runtime) record.runtime.kill('SIGTERM');
    record.stopped = true;
    if (record.status !== 'error') record.status = 'stopped';
    const err = new Error(reason || 'runtime stopped');
    this._failPending(record, err);
    this._log('info', 'claude pty runtime stopped', record, { queueDepth: record.pending.size, exitReason: reason || 'stopped' });
    return this._snapshot(record);
  }

  deleteRuntime(runtimeId, reason) {
    const record = this.runtimes.get(runtimeId);
    if (!record) return null;
    this.stopRuntime(runtimeId, reason || 'deleted');
    this.runtimes.delete(runtimeId);
    return null;
  }

  detachAllRuntimes(reason) {
    const err = new Error(reason || 'runtime detached');
    for (const record of Array.from(this.runtimes.values())) {
      this._failPending(record, err);
      record.subscribers.clear();
      record.runtime = null;
      record.stopped = true;
      record.status = 'detached';
      this._log('info', 'claude pty runtime detached', record, { queueDepth: record.pending.size, exitReason: reason || 'detached' });
    }
    this.runtimes.clear();
  }

  writeInput(runtimeId, data, options) {
    const opts = options || {};
    if (!Buffer.isBuffer(data) && typeof data !== 'string') throw new TypeError('data must be Buffer or string');
    if (!this.runtimes.has(runtimeId) && this.bridgeSidecar && typeof this.bridgeSidecar.writeInput === 'function') {
      const bridgeRuntime = this._getBridgeRuntime(runtimeId);
      if (!this._isBridgeRuntimeActive(bridgeRuntime)) throw new Error('runtime is not active: ' + ((bridgeRuntime && bridgeRuntime.status) || 'missing'));
      return Promise.resolve(this.bridgeSidecar.writeInput(runtimeId, data, opts));
    }
    const record = this._requireActive(runtimeId);
    if (record.pending.size >= this.queueLimit) throw new Error('queue limit exceeded');
    const source = opts.source || 'unknown';
    this._log('info', 'claude pty input write', record, { source, queueDepth: record.pending.size });
    return this._track(record, () => record.runtime.write(data));
  }

  resize(runtimeId, cols, rows) {
    const record = this._requireActive(runtimeId);
    if (record.pending.size >= this.queueLimit) throw new Error('queue limit exceeded');
    this._log('info', 'claude pty resize', record, { queueDepth: record.pending.size });
    return this._track(record, () => record.runtime.resize(cols, rows));
  }

  subscribeOutput(runtimeId, fn, options) {
    if (typeof fn !== 'function') throw new TypeError('subscriber must be a function');
    const record = this._requireActive(runtimeId);
    const opts = options || {};
    if (opts.replay !== false) {
      for (const chunk of record.replay) fn(chunk);
    }
    record.subscribers.add(fn);
    return () => record.subscribers.delete(fn);
  }

  _createRecord(runtimeId, claudeSessionId, processGeneration, opts) {
    if (!claudeSessionId) throw new Error('claudeSessionId is required');
    return {
      runtimeId,
      claudeSessionId,
      processGeneration,
      cwd: opts.cwd || this.cwd || process.cwd(),
      env: { ...this.env, ...(opts.env || {}) },
      status: 'starting',
      runtime: null,
      replay: [],
      replayBytes: 0,
      subscribers: new Set(),
      pending: new Set(),
      error: null,
      stopped: false,
    };
  }

  _spawn(record, args, opts) {
    try {
      record.runtime = createClaudePtyRuntime({
        command: this.command,
        args,
        cwd: opts.cwd || record.cwd,
        env: { ...record.env, ...(opts.env || {}) },
        pty: this.ptyFactory,
        cols: opts.cols,
        rows: opts.rows,
      });
      const runtime = record.runtime;
      const processGeneration = record.processGeneration;
      runtime.on('data', (chunk) => {
        if (record.runtime !== runtime || record.processGeneration !== processGeneration) return;
        this._handleData(record, chunk);
      });
      runtime.on('exit', (event) => {
        if (record.runtime !== runtime || record.processGeneration !== processGeneration) return;
        this._handleExit(record, event);
      });
      record.status = 'active';
    } catch (err) {
      record.status = 'error';
      record.error = err;
      this._log('error', 'claude pty runtime spawn failed', record, { queueDepth: record.pending.size, err });
      throw err;
    }
  }

  _launchArgs(opts, fallback) {
    return Array.isArray(opts.launchArgs) && opts.launchArgs.length > 0 ? opts.launchArgs.slice() : fallback;
  }

  _handleData(record, chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    record.replay.push(buf);
    record.replayBytes += buf.length;
    while (record.replayBytes > this.replayLimitBytes && record.replay.length > 0) {
      const overflow = record.replayBytes - this.replayLimitBytes;
      const first = record.replay[0];
      if (first.length <= overflow) {
        record.replay.shift();
        record.replayBytes -= first.length;
      } else {
        record.replay[0] = first.subarray(overflow);
        record.replayBytes -= overflow;
      }
    }
    for (const subscriber of record.subscribers) subscriber(buf);
  }

  _handleExit(record, event) {
    const exitCode = event && event.exitCode != null ? event.exitCode : 0;
    const signal = event && event.signal;
    const exitReason = signal ? 'signal ' + signal : 'exit code ' + exitCode;
    const ok = exitCode === 0;
    record.status = ok ? 'stopped' : 'error';
    record.stopped = true;
    if (!ok) record.error = new Error('pty runtime exited with ' + exitReason);
    this._failPending(record, record.error || new Error('pty runtime exited with ' + exitReason));
    this._log(ok ? 'info' : 'error', 'claude pty runtime exited', record, { queueDepth: record.pending.size, exitReason });
  }

  _track(record, fn) {
    let result;
    try {
      result = fn();
    } catch (err) {
      return Promise.reject(err);
    }
    if (!result || typeof result.then !== 'function') return Promise.resolve(result);
    const promise = Promise.resolve(result);
    const pending = { promise, reject: null, settled: false };
    const tracked = new Promise((resolve, reject) => {
      pending.reject = reject;
      promise.then(resolve, reject).finally(() => {
        pending.settled = true;
        record.pending.delete(pending);
      });
    });
    record.pending.add(pending);
    return tracked;
  }

  _failPending(record, err) {
    for (const pending of Array.from(record.pending)) {
      if (!pending.settled && typeof pending.reject === 'function') pending.reject(err);
      record.pending.delete(pending);
    }
  }

  _requireActive(runtimeId) {
    const record = this.runtimes.get(runtimeId);
    if (!record) throw new Error('runtime not found: ' + runtimeId);
    if (record.status !== 'active') throw record.error || new Error('runtime is not active: ' + record.status);
    return record;
  }

  _getBridgeRuntime(runtimeId) {
    if (!runtimeId || !this.bridgeSidecar || typeof this.bridgeSidecar.getRuntime !== 'function') return null;
    let runtime;
    try {
      runtime = this.bridgeSidecar.getRuntime(runtimeId);
    } catch (_) {
      return null;
    }
    if (!runtime) return null;
    return {
      ...runtime,
      transport: 'bridge-sidecar',
      agentRef: {
        provider: 'claude',
        transport: 'bridge-sidecar',
        runtimeId: runtime.runtimeId,
        claudeSessionId: runtime.claudeSessionId,
        processGeneration: runtime.processGeneration,
      },
    };
  }

  _isBridgeRuntimeActive(runtime) {
    if (!runtime || runtime.reconnectable === false) return false;
    return runtime.status === 'active' || runtime.status === 'walker-disconnected' || runtime.connectionState === 'reconnectable';
  }

  _registerBridgeRuntime(record) {
    if (!this.bridgeSidecar || typeof this.bridgeSidecar.registerRuntime !== 'function') return;
    this.bridgeSidecar.registerRuntime({
      runtimeId: record.runtimeId,
      claudeSessionId: record.claudeSessionId,
      status: record.status,
      processGeneration: record.processGeneration,
      cwd: record.cwd,
      runtime: record.runtime,
      reconnectable: true,
    });
  }

  _snapshot(record) {
    const snapshot = {
      runtimeId: record.runtimeId,
      claudeSessionId: record.claudeSessionId,
      processGeneration: record.processGeneration,
      status: record.status,
      cwd: record.cwd,
      replayBytes: record.replayBytes,
      queueDepth: record.pending.size,
      agentRef: {
        provider: 'claude',
        transport: 'pty-attach',
        runtimeId: record.runtimeId,
        claudeSessionId: record.claudeSessionId,
        processGeneration: record.processGeneration,
      },
    };
    if (record.error) snapshot.error = { message: record.error.message, code: record.error.code };
    return snapshot;
  }

  _log(level, message, record, extra) {
    const row = {
      runtimeId: record.runtimeId,
      processGeneration: record.processGeneration,
      ...extra,
    };
    this.logger[level](message, row);
  }
}

module.exports = { ClaudePtyBroker, DEFAULT_REPLAY_LIMIT_BYTES, DEFAULT_QUEUE_LIMIT };
