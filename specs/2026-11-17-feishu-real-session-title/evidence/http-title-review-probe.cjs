'use strict';

process.env.WALKER_LOG_FILE = 'false';
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(process.argv[2] || process.cwd());
const { OpencodeDriver } = require(path.join(root, 'src/drivers/opencode-driver'));

/** 复核审查反例：真实客户端必须完整解码分块标题且不记录失败正文。 */
async function probe() {
  const title = '中文标题';
  const marker = 'SYNTHETIC_SECRET_DO_NOT_LOG';
  let invalid = false;
  const server = http.createServer((_req, res) => {
    if (invalid) {
      res.writeHead(401);
      res.end('authorization=' + marker);
      return;
    }
    const payload = Buffer.from(JSON.stringify({ data: { id: 'ses_A', title } }));
    const split = payload.indexOf(Buffer.from(title)) + 1;
    res.write(payload.subarray(0, split));
    setTimeout(() => res.end(payload.subarray(split)), 25);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const driver = new OpencodeDriver({ serverUrl: 'http://127.0.0.1:' + server.address().port, readServiceRecord: () => null });
  try {
    const actual = await driver.getSessionTitle({ opencodeSessionId: 'ses_A' });
    invalid = true;
    let captured = '';
    let failure;
    const original = process.stderr.write;
    process.stderr.write = function capture(chunk) { captured += String(chunk); return true; };
    try {
      await driver.getSessionTitle({ opencodeSessionId: 'ses_A' });
    } catch (error) {
      failure = error.code;
    } finally {
      process.stderr.write = original;
    }
    const report = { node: process.version, expectedTitle: title, actualTitle: actual,
      titleIntact: actual === title, failure, leakedSyntheticMarker: captured.includes(marker) };
    console.log(JSON.stringify(report, null, 2));
    assert.ok(report.titleIntact && !report.leakedSyntheticMarker && failure === 'TITLE_FORBIDDEN', '标题应完整且错误正文不得进入日志');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

probe().catch((error) => { console.error(error.message); process.exitCode = 1; });
