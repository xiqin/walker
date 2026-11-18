'use strict';

// 复现已观察到的来源差异：旧表无匹配，所属TUI服务已有真实标题。
const path = require('node:path');
const os = require('node:os');
const { JsonStore } = require('../../../src/core/json-store');
const { SessionService } = require('../../../src/core/session-service');
const { OpencodeTuiBridge } = require('../../../src/opencode-tui-bridge/bridge');
const { OpencodeDriver } = require('../../../src/drivers/opencode-driver');
const sessionService = new SessionService({ stateStore: new JsonStore(path.join(os.homedir(), 'state.json'), {}) });
const bridge = new OpencodeTuiBridge({ sessionService });
const expected = '所属V2服务的真实标题';
let sqliteReads = 0;
bridge.register({ runtimeId: 'runtime-owned', sessionId: 'ses_owned', cwd: os.homedir(),
  opencodeVersion: '2.1.1', sessionTitle: { id: 'ses_owned', title: expected } });
const driver = new OpencodeDriver({ serverUrl: 'http://127.0.0.1:1', autostart: false,
  readServiceRecord: () => null, modelState: {}, tuiBridge: bridge,
  opencodeDbPath: path.join(os.homedir(), 'legacy.db'),
  execFile: async () => { sqliteReads++; return { stdout: '' }; } });
(async () => {
  let actual = null;
  try { actual = await driver.getSessionTitle({ transport: 'tui-bridge', runtimeId: 'runtime-owned', opencodeSessionId: 'ses_owned' }); }
  finally { bridge.close(); }
  const passed = actual === expected && sqliteReads === 0;
  console.log(JSON.stringify({ expected, actual, sqliteReads, passed }));
  process.exitCode = passed ? 0 : 1;
})().catch(error => { bridge.close(); console.error(error.code || error.name); process.exitCode = 1; });
