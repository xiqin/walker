'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const net = require('net');
const http = require('http');
const https = require('https');
const Module = require('module');

const { main, CLAUDE_REMOVED_CODE, CLAUDE_REMOVED_MESSAGE } = require('../src/index');
const { createOutput } = require('../src/cli/cli-output');

const REMOVED_MESSAGE = 'Claude integration has been removed.';
const TOKEN = 'walker-cli-token-sentinel-7f3a9c2e';
const ATTACH_URL = 'ws://127.0.0.1:9/attach?token=' + TOKEN;

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function runCli(args) {
  const binDir = makeTempDir('walker-t1-cli-');
  const marker = path.join(binDir, 'invoked.txt');
  fs.writeFileSync(path.join(binDir, 'claude.cmd'), '@echo off\r\necho invoked>"' + marker + '"\r\n');
  const previous = {
    PATH: process.env.PATH,
    WALKER_CLAUDE_ATTACH_URL: process.env.WALKER_CLAUDE_ATTACH_URL,
    WALKER_CLAUDE_ATTACH_TOKEN: process.env.WALKER_CLAUDE_ATTACH_TOKEN,
  };
  process.env.PATH = binDir + path.delimiter + (process.env.PATH || '');
  process.env.WALKER_CLAUDE_ATTACH_URL = ATTACH_URL;
  process.env.WALKER_CLAUDE_ATTACH_TOKEN = TOKEN;

  const calls = [];
  const originals = {
    spawn: childProcess.spawn,
    spawnSync: childProcess.spawnSync,
    exec: childProcess.exec,
    execSync: childProcess.execSync,
    execFile: childProcess.execFile,
    execFileSync: childProcess.execFileSync,
    fork: childProcess.fork,
    connect: net.Socket.prototype.connect,
    request: http.request,
    httpsRequest: https.request,
    require: Module.prototype.require,
    WebSocket: global.WebSocket,
  };
  let wsModule = null;
  let originalWs = null;
  try {
    wsModule = require('ws');
    originalWs = wsModule.WebSocket;
  } catch (_) {
    wsModule = null;
  }

  function record(type, detail) {
    calls.push({ type, detail: String(detail) });
  }
  childProcess.spawn = function spawnProbe(...probeArgs) {
    record('spawn', probeArgs[0]);
    return { unref() {}, on() { return this; }, pid: 0 };
  };
  childProcess.spawnSync = function spawnSyncProbe(...probeArgs) {
    record('spawnSync', probeArgs[0]);
    return { status: 0, stdout: '', stderr: '' };
  };
  childProcess.exec = function execProbe(...probeArgs) {
    record('exec', probeArgs[0]);
    const cb = probeArgs.find((arg) => typeof arg === 'function');
    if (cb) process.nextTick(() => cb(null, '', ''));
    return { unref() {}, on() { return this; }, pid: 0 };
  };
  childProcess.execSync = function execSyncProbe(...probeArgs) {
    record('execSync', probeArgs[0]);
    return '';
  };
  childProcess.execFile = function execFileProbe(...probeArgs) {
    record('execFile', probeArgs[0]);
    const cb = probeArgs.find((arg) => typeof arg === 'function');
    if (cb) process.nextTick(() => cb(null, '', ''));
    return { unref() {}, on() { return this; }, pid: 0 };
  };
  childProcess.execFileSync = function execFileSyncProbe(...probeArgs) {
    record('execFileSync', probeArgs[0]);
    return '';
  };
  childProcess.fork = function forkProbe(...probeArgs) {
    record('fork', probeArgs[0]);
    return { unref() {}, on() { return this; }, pid: 0 };
  };
  net.Socket.prototype.connect = function connectProbe(...probeArgs) {
    record('connect', JSON.stringify(probeArgs));
    if (JSON.stringify(probeArgs).includes(TOKEN) || JSON.stringify(probeArgs).includes(ATTACH_URL)) {
      throw new Error('unexpected connect');
    }
    return originals.connect.apply(this, probeArgs);
  };
  http.request = function requestProbe(...probeArgs) {
    record('http', JSON.stringify(probeArgs[0]));
    return originals.request.apply(this, probeArgs);
  };
  https.request = function httpsRequestProbe(...probeArgs) {
    record('https', JSON.stringify(probeArgs[0]));
    return originals.httpsRequest.apply(this, probeArgs);
  };
  Module.prototype.require = function requireProbe(id) {
    if (id === 'ws' || id === 'websocket') record('require', id);
    return originals.require.apply(this, arguments);
  };
  function WrappedWebSocket(...probeArgs) {
    record('websocket', JSON.stringify(probeArgs));
    throw new Error('WebSocket constructed');
  }
  global.WebSocket = WrappedWebSocket;
  if (wsModule && originalWs) wsModule.WebSocket = WrappedWebSocket;

  const stdout = [];
  const stderr = [];
  const exits = [];
  const output = createOutput({
    stdout: { write(chunk) { stdout.push(String(chunk)); return true; } },
    stderr: { write(chunk) { stderr.push(String(chunk)); return true; } },
  });
  let markerExists = false;
  try {
    await main(args, {
      output,
      exit(code) { exits.push(code); },
    });
    markerExists = fs.existsSync(marker);
  } finally {
    childProcess.spawn = originals.spawn;
    childProcess.spawnSync = originals.spawnSync;
    childProcess.exec = originals.exec;
    childProcess.execSync = originals.execSync;
    childProcess.execFile = originals.execFile;
    childProcess.execFileSync = originals.execFileSync;
    childProcess.fork = originals.fork;
    net.Socket.prototype.connect = originals.connect;
    http.request = originals.request;
    https.request = originals.httpsRequest;
    Module.prototype.require = originals.require;
    if (originals.WebSocket === undefined) delete global.WebSocket;
    else global.WebSocket = originals.WebSocket;
    if (wsModule && originalWs) wsModule.WebSocket = originalWs;
    if (previous.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = previous.PATH;
    if (previous.WALKER_CLAUDE_ATTACH_URL === undefined) delete process.env.WALKER_CLAUDE_ATTACH_URL;
    else process.env.WALKER_CLAUDE_ATTACH_URL = previous.WALKER_CLAUDE_ATTACH_URL;
    if (previous.WALKER_CLAUDE_ATTACH_TOKEN === undefined) delete process.env.WALKER_CLAUDE_ATTACH_TOKEN;
    else process.env.WALKER_CLAUDE_ATTACH_TOKEN = previous.WALKER_CLAUDE_ATTACH_TOKEN;
    fs.rmSync(binDir, { recursive: true, force: true });
  }
  return {
    stdout,
    stderr,
    exits,
    calls,
    markerExists,
    text: stdout.concat(stderr).join(''),
  };
}

function assertNoClaudeExecution(result) {
  assert.equal(result.markerExists, false);
  assert.equal(result.text.includes(TOKEN), false);
  assert.equal(result.text.includes(ATTACH_URL), false);
  assert.equal(result.calls.some((call) => call.type === 'websocket'), false);
  assert.equal(result.calls.some((call) => call.type === 'connect'), false);
  assert.equal(result.calls.some((call) => /claude/i.test(call.detail)), false);
}

describe('removed claude cli', () => {
  it('导出错误码且用户可见消息精确', () => {
    assert.equal(CLAUDE_REMOVED_CODE, 'claude_removed');
    assert.equal(CLAUDE_REMOVED_MESSAGE, REMOVED_MESSAGE);
  });

  it('REQ-002-B02: claude、claude attach 与 claude attach rt_1 均退出 1 且消息精确', async () => {
    const argSets = [['claude'], ['claude', 'attach'], ['claude', 'attach', 'rt_1']];
    for (const args of argSets) {
      const result = await runCli(args);
      assert.deepEqual(result.exits, [1], args.join(' '));
      assert.deepEqual(result.stderr, [REMOVED_MESSAGE + '\n'], args.join(' '));
      assert.deepEqual(result.stdout, [], args.join(' '));
      assert.equal(result.text.includes('claude_removed'), false, args.join(' '));
      assertNoClaudeExecution(result);
    }
  });

  it('REQ-002-B05: 设置 attach URL 和 token 后不连接且输出不含哨兵', async () => {
    const result = await runCli(['claude', 'attach', 'rt_1']);
    assert.deepEqual(result.exits, [1]);
    assert.equal(result.text, REMOVED_MESSAGE + '\n');
    assert.equal(result.calls.filter((call) => call.type === 'require' && call.detail === 'ws').length, 0);
    assert.equal(result.calls.filter((call) => call.type === 'http' || call.type === 'https').length, 0);
    assertNoClaudeExecution(result);
  });

  it('REQ-002-B06: help 含 providers 与 init，不含 claude attach', async () => {
    const result = await runCli(['help']);
    assert.deepEqual(result.exits, [0]);
    assert.match(result.text, /walker providers list/);
    assert.match(result.text, /walker init/);
    assert.equal(result.text.includes('claude attach'), false);
    assert.equal(/claude attach/i.test(result.text), false);
    assert.equal(result.text.includes(REMOVED_MESSAGE), false);
    assertNoClaudeExecution(result);
  });

  it('未知子命令与大写 Claude 走未知命令且不执行 claude', async () => {
    for (const arg of ['nope', 'Claude', 'CLAUDE']) {
      const result = await runCli([arg]);
      assert.deepEqual(result.exits, [1], arg);
      assert.match(result.text, new RegExp('unknown command: ' + arg));
      assert.equal(result.text.includes(REMOVED_MESSAGE), false, arg);
      assert.match(result.text, /walker providers list/);
      assertNoClaudeExecution(result);
    }
  });
});
