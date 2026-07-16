const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { DefaultHttpClient } = require('../src/drivers/opencode-http-client');

describe('DefaultHttpClient', () => {
  it('不覆盖显式传入的 timeoutMs 为 0', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/test';
    try {
      const client = new DefaultHttpClient();
      const opts = { timeoutMs: 0 };
      await client.request('GET', url, null, opts);
      assert.equal(opts.timeoutMs, 0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
