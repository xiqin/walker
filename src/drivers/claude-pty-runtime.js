'use strict';

const { EventEmitter } = require('node:events');

function createRuntimeError(message, cause) {
  const err = new Error(message);
  err.code = 'CLAUDE_PTY_RUNTIME_UNAVAILABLE';
  if (cause) err.cause = cause;
  return err;
}

function loadNodePty() {
  try {
    return require('node-pty');
  } catch (err) {
    throw createRuntimeError('pty runtime spawn failed: node-pty is unavailable or ConPTY cannot be initialized', err);
  }
}

class ClaudePtyRuntime extends EventEmitter {
  constructor(options) {
    super();
    const opts = options || {};
    this.command = opts.command;
    this.args = Array.isArray(opts.args) ? opts.args.slice() : [];
    this.cwd = opts.cwd || process.cwd();
    this.env = opts.env || process.env;
    this.cols = opts.cols || 80;
    this.rows = opts.rows || 24;
    this._pty = opts.pty || loadNodePty();
    this._proc = null;
    this._disposed = false;
    this._disposables = [];
  }

  start() {
    if (this._proc) return this;
    try {
      this._proc = this._pty.spawn(this.command, this.args, {
        name: 'xterm-256color',
        cwd: this.cwd,
        env: this.env,
        cols: this.cols,
        rows: this.rows,
      });
    } catch (err) {
      throw createRuntimeError('pty runtime spawn failed: ' + sanitizeErrorMessage(err), err);
    }

    if (!this._proc || typeof this._proc.write !== 'function') {
      throw createRuntimeError('pty runtime spawn failed: invalid pty process');
    }

    if (typeof this._proc.onData === 'function') {
      this._disposables.push(this._proc.onData((data) => this.emit('data', data)));
    } else if (typeof this._proc.on === 'function') {
      this._proc.on('data', (data) => this.emit('data', data));
    }

    if (typeof this._proc.onExit === 'function') {
      this._disposables.push(this._proc.onExit((event) => this.emit('exit', normalizeExit(event))));
    } else if (typeof this._proc.on === 'function') {
      this._proc.on('exit', (event) => this.emit('exit', normalizeExit(event)));
    }
    return this;
  }

  write(data) {
    if (!this._proc) throw new Error('pty runtime is not started');
    return this._proc.write(data);
  }

  resize(cols, rows) {
    if (!this._proc) throw new Error('pty runtime is not started');
    if (typeof this._proc.resize !== 'function') return undefined;
    return this._proc.resize(cols, rows);
  }

  kill(signal) {
    if (this._disposed) return;
    this._disposed = true;
    for (const disposable of this._disposables) {
      if (disposable && typeof disposable.dispose === 'function') disposable.dispose();
    }
    this._disposables = [];
    if (this._proc && typeof this._proc.kill === 'function') this._proc.kill(signal);
  }
}

function normalizeExit(event) {
  if (event && typeof event === 'object') {
    return {
      exitCode: event.exitCode != null ? event.exitCode : event.code,
      signal: event.signal || null,
    };
  }
  return { exitCode: event, signal: null };
}

function sanitizeErrorMessage(err) {
  const message = err && err.message ? String(err.message) : String(err || 'unknown error');
  return message.replace(/(token|secret|password|authorization|apikey|api_key)=([^\s]+)/ig, '$1=***');
}

function createClaudePtyRuntime(options) {
  return new ClaudePtyRuntime(options).start();
}

module.exports = { ClaudePtyRuntime, createClaudePtyRuntime, createRuntimeError };
