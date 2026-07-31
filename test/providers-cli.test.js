'use strict';

const assert = require('assert');
const test = require('node:test');

const providersCommand = require('../src/cli/providers-command');
const indexCli = require('../src/index');
const outputTools = require('../src/cli/cli-output');

function createOutputCapture() {
  const stdout = [];
  const stderr = [];
  return {
    output: {
      write(line) { stdout.push(line); },
      error(line) { stderr.push(line); },
    },
    stdout,
    stderr,
    text() { return stdout.concat(stderr).join('\n'); },
  };
}

function createSanitizedOutputCapture() {
  const stdout = [];
  const stderr = [];
  return {
    output: outputTools.createOutput({
      stdout: { write(chunk) { stdout.push(String(chunk)); } },
      stderr: { write(chunk) { stderr.push(String(chunk)); } },
    }),
    stdout,
    stderr,
    text() { return stdout.concat(stderr).join(''); },
  };
}

function createRegistry() {
  return {
    listProviders() {
      return [
        { id: 'opencode', label: 'OpenCode', driver: 'opencode', registered: true, capabilities: { sessions: true, tui: true }, configKeys: ['OPENCODE_CMD'] },
        { id: 'shell', label: 'Shell', driver: 'shell', registered: false, capabilities: { commands: true }, configKeys: ['SHELL'] },
      ];
    },
    async listProviderStatuses() {
      return [
        { id: 'opencode', label: 'OpenCode', installed: true, version: '1.2.3', healthy: true, health: { status: 'healthy', summary: 'ready' }, problems: [], suggestions: [], capabilities: { sessions: true, tui: true }, configKeys: ['OPENCODE_CMD'], registered: true },
        { id: 'shell', label: 'Shell', installed: true, version: '', healthy: true, health: { status: 'healthy', summary: 'builtin' }, problems: [], suggestions: [], capabilities: { commands: true }, configKeys: ['SHELL'], registered: false },
      ];
    },
    async doctorProvider(id) {
      if (id === 'missing') return { ok: false, error: { code: 'NOT_FOUND', message: 'unknown provider: missing' } };
      return {
        ok: true,
        provider: { id, label: 'OpenCode', installed: true, version: '1.2.3', healthy: true, health: { status: 'healthy', summary: 'ready' }, problems: [], suggestions: [], capabilities: { sessions: true }, configKeys: ['OPENCODE_CMD'], registered: true },
      };
    },
  };
}

test('providers list prints provider statuses without real provider dependency', async () => {
  const capture = createOutputCapture();
  const code = await providersCommand.run(['list'], { registry: createRegistry(), output: capture.output });

  const text = capture.text();
  assert.equal(code, 0);
  assert.match(text, /Providers/);
  assert.match(text, /opencode/);
  assert.match(text, /OpenCode/);
  assert.match(text, /healthy/);
  assert.match(text, /shell/);
});

test('providers doctor reports one provider', async () => {
  const capture = createOutputCapture();
  const code = await providersCommand.run(['doctor', 'opencode'], { registry: createRegistry(), output: capture.output });

  const text = capture.text();
  assert.equal(code, 0);
  assert.match(text, /Provider: opencode/);
  assert.match(text, /OpenCode/);
  assert.match(text, /ready/);
});

test('providers doctor unknown returns clear error and non-zero exit code', async () => {
  const capture = createOutputCapture();
  const code = await providersCommand.run(['doctor', 'missing'], { registry: createRegistry(), output: capture.output });

  assert.equal(code, 1);
  assert.match(capture.text(), /unknown provider: missing/);
});

test('REQ-003-B04: providers doctor 输出 provider 错误时经过脱敏层', async () => {
  const capture = createSanitizedOutputCapture();
  const secret = 'raw-provider-secret';
  const registry = {
    async doctorProvider(id) {
      return {
        ok: true,
        provider: {
          id,
          label: 'OpenCode',
          installed: true,
          version: '',
          healthy: false,
          health: { status: 'failed', summary: 'TOKEN=' + secret + ' failed' },
          problems: [{ code: 'VERSION_FAILED', message: 'API_KEY=' + secret + ' failed' }],
          suggestions: ['Run with Bearer ' + secret + ' should be hidden.'],
          capabilities: { sessions: true },
          configKeys: ['OPENCODE_CMD'],
          registered: true,
        },
      };
    },
  };

  const code = await providersCommand.run(['doctor', 'opencode'], { registry, output: capture.output });

  const text = capture.text();
  assert.equal(code, 1);
  assert.match(text, /Problem: API_KEY=\[redacted\] failed/);
  assert.match(text, /Bearer \[redacted\]/);
  assert.doesNotMatch(text, new RegExp(secret));
});

test('CLI usage keeps existing commands and adds new entries', () => {
  const capture = createOutputCapture();
  indexCli.printUsage(capture.output);

  const text = capture.text();
  assert.match(text, /walker\s+Start walker in foreground/);
  assert.match(text, /walker start\s+Start walker in background/);
  assert.match(text, /walker stop\s+Stop background walker/);
  assert.match(text, /walker status\s+Show background walker status/);
  assert.match(text, /walker logs \[N\]\s+Show last N lines/);
  assert.match(text, /walker doctor\s+Run read-only diagnostics/);
  assert.match(text, /walker providers list\s+List available providers/);
  assert.match(text, /walker providers doctor \[id\]\s+Diagnose provider/);
  assert.match(text, /walker init\s+Initialize Walker data directory and config/);
});
