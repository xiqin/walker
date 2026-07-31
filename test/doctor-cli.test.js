'use strict';

const assert = require('assert');
const test = require('node:test');

const doctorCommand = require('../src/cli/doctor-command');
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

test('doctor outputs Core, Platforms, Providers and Suggestions without leaking secrets', async () => {
  const capture = createOutputCapture();
  const secret = 'super-secret-admin-token';
  const appSecret = 'feishu-secret-value';
  const registry = {
    async listProviderStatuses() {
      return [
        {
          id: 'opencode',
          label: 'OpenCode',
          installed: true,
          version: '1.2.3',
          healthy: true,
          health: { status: 'healthy', summary: 'ready' },
          problems: [],
          suggestions: [],
          capabilities: { sessions: true, tui: true },
          configKeys: ['OPENCODE_CMD'],
          registered: true,
        },
      ];
    },
  };

  const code = await doctorCommand.run([], {
    env: {
      FEISHU_APP_ID: 'cli_app_id',
      FEISHU_APP_SECRET: appSecret,
      WALKER_ADMIN_TOKEN: secret,
      WALKER_DATA_DIR: 'C:\\walker-secret-dir',
    },
    cwd: 'H:\\walker',
    nodeVersion: 'v22.11.0',
    registry,
    output: capture.output,
  });

  const text = capture.text();
  assert.equal(code, 0);
  assert.match(text, /Core/);
  assert.match(text, /Platforms/);
  assert.match(text, /Providers/);
  assert.match(text, /Suggestions/);
  assert.match(text, /admin token\s+present/);
  assert.match(text, /FEISHU_APP_SECRET\s+present/);
  assert.doesNotMatch(text, new RegExp(secret));
  assert.doesNotMatch(text, new RegExp(appSecret));
});

test('doctor continues after provider failure and reports problem plus suggestion', async () => {
  const capture = createOutputCapture();
  const registry = {
    async listProviderStatuses() {
      return [
        {
          id: 'opencode',
          label: 'OpenCode',
          installed: false,
          version: '',
          healthy: false,
          health: { status: 'failed', summary: 'opencode not found' },
          problems: [{ code: 'COMMAND_NOT_FOUND', message: 'opencode command not found' }],
          suggestions: ['Install OpenCode or set OPENCODE_CMD.'],
          capabilities: { sessions: true },
          configKeys: ['OPENCODE_CMD'],
          registered: true,
        },
        {
          id: 'shell',
          label: 'Shell',
          installed: true,
          version: '',
          healthy: true,
          health: { status: 'healthy', summary: 'builtin' },
          problems: [],
          suggestions: [],
          capabilities: { commands: true },
          configKeys: ['SHELL'],
          registered: false,
        },
      ];
    },
  };

  const code = await doctorCommand.run([], {
    env: {},
    cwd: 'H:\\walker',
    nodeVersion: 'v22.11.0',
    registry,
    output: capture.output,
  });

  const text = capture.text();
  assert.equal(code, 1);
  assert.match(text, /OpenCode/);
  assert.match(text, /Shell/);
  assert.match(text, /Problem: opencode command not found/);
  assert.match(text, /Suggestion: Install OpenCode or set OPENCODE_CMD\./);
  assert.match(text, /FEISHU_APP_ID is missing/);
});

test('REQ-003-B04: doctor 输出 provider 诊断错误时经过脱敏层', async () => {
  const capture = createSanitizedOutputCapture();
  const secret = 'raw-doctor-secret';
  const registry = {
    async listProviderStatuses() {
      return [
        {
          id: 'opencode',
          label: 'OpenCode',
          installed: true,
          version: '',
          healthy: false,
          health: { status: 'failed', summary: 'PASSWORD=' + secret + ' failed' },
          problems: [{ code: 'VERSION_FAILED', message: 'TOKEN=' + secret + ' failed' }],
          suggestions: ['Retry with Bearer ' + secret + '.'],
          capabilities: { sessions: true },
          configKeys: ['OPENCODE_CMD'],
          registered: true,
        },
      ];
    },
  };

  const code = await doctorCommand.run([], {
    env: { FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', WALKER_ADMIN_TOKEN: 'token' },
    cwd: 'H:\\walker',
    nodeVersion: 'v22.11.0',
    registry,
    output: capture.output,
  });

  const text = capture.text();
  assert.equal(code, 1);
  assert.match(text, /Problem: TOKEN=\[redacted\] failed/);
  assert.match(text, /Bearer \[redacted\]/);
  assert.doesNotMatch(text, new RegExp(secret));
});

test('doctor is read-only and does not call injected mutating dependencies', async () => {
  const capture = createOutputCapture();
  const calls = [];
  const registry = {
    async listProviderStatuses() {
      calls.push('listProviderStatuses');
      return [];
    },
    register() { calls.push('register'); },
    unregister() { calls.push('unregister'); },
    clear() { calls.push('clear'); },
  };

  const code = await doctorCommand.run([], {
    env: { FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', WALKER_ADMIN_TOKEN: 'token' },
    cwd: 'H:\\walker',
    nodeVersion: 'v22.11.0',
    registry,
    output: capture.output,
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, ['listProviderStatuses']);
  assert.match(capture.text(), /Read-only: no configuration, shell profile, service, or third-party secret was modified\./);
});
