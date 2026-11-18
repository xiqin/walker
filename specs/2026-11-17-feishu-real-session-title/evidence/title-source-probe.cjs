'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(process.argv[2] || process.cwd());
const { MessageDispatcher } = require(path.join(root, 'src/dispatch/message-dispatcher'));
const { FeishuApi } = require(path.join(root, 'src/platform/feishu/api'));

/** 在真实文本发送边界观察标题；仅拦截网络，不访问真实飞书或会话数据。 */
async function probe() {
  const expectedTitle = '事件触发客户信息同步';
  const session = {
    id: 'wks_M7A3D1RA', title: 'session wks_M7A3D1RA', agent: 'opencode',
    model: 'seasun/grok-4.7', contextTokens: 169507,
    agentRef: { opencodeSessionId: 'ses_title_probe', transport: 'tui-bridge' },
  };
  const dispatcher = Object.create(MessageDispatcher.prototype);
  dispatcher.sessionService = { getSession: () => session };
  dispatcher.driverRegistry = { get: () => ({ getSessionTitle: async () => expectedTitle }) };
  const api = new FeishuApi({ appId: 'probe', appSecret: 'probe' });
  api.token = 'probe';
  api.tokenExpiresAt = Date.now() + 60000;
  let actual;
  api._request = async (_method, _host, _url, body) => {
    actual = JSON.parse(JSON.parse(body).content).text;
    return { code: 0, data: { message_id: 'probe' } };
  };
  await api.sendText('probe', '复现正文', await dispatcher._feishuRuntimeContext({ session }));
  const report = {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    node: process.version,
    expectedTitle,
    localTitle: session.title,
    actual,
    passed: actual.includes('会话：' + expectedTitle) && !actual.includes('session wks_'),
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n', 'utf8');
  assert.ok(report.passed, '页脚应显示关联 OpenCode 标题，不应显示 Walker 默认名称');
}

probe().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
