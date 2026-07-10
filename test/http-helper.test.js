const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { httpRequest, sseConnect } = require('../src/core/http-helper');

describe('httpRequest', () => {
  it('超过 timeoutMs 时销毁请求并返回包含 URL 的错误', async () => {
    const server = http.createServer((_req, _res) => {});

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/slow';

    try {
      await assert.rejects(
        () => httpRequest('GET', url, null, null, { timeoutMs: 20 }),
        (err) => err.message.includes('timed out') && err.message.includes(url)
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('sseConnect', () => {
  it('收到完成事件后不等待 SSE 长连接自然结束', async () => {
    let response;
    const server = http.createServer((req, res) => {
      response = res;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('data: {"type":"session.status","properties":{"status":{"type":"idle"}}}\n\n');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const events = await Promise.race([
        sseConnect('http://127.0.0.1:' + port + '/event', null, {
          shouldClose: (event) => event.type === 'session.status' && event.properties.status.type === 'idle',
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('sseConnect timed out')), 100)),
      ]);

      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'session.status');
    } finally {
      if (response) response.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('超过 timeoutMs 时主动结束 SSE 等待', async () => {
    let response;
    const server = http.createServer((req, res) => {
      response = res;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('data: {"type":"server.connected","properties":{}}\n\n');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      await assert.rejects(
        () => sseConnect('http://127.0.0.1:' + port + '/event', null, { timeoutMs: 20 }),
        /SSE connection timed out/
      );
    } finally {
      if (response) response.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('非 2xx 响应时拒绝且不调用 onOpen', async () => {
    let opened = false;
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"type":"error"}\n\n');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/event';

    try {
      await assert.rejects(
        () => sseConnect(url, null, { onOpen: () => { opened = true; } }),
        (err) => err.message.includes('500') && err.message.includes(url)
      );
      assert.equal(opened, false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('非 event-stream 响应时拒绝且不调用 onOpen', async () => {
    let opened = false;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/event';

    try {
      await assert.rejects(
        () => sseConnect(url, null, { onOpen: () => { opened = true; } }),
        (err) => err.message.includes('text/event-stream') && err.message.includes(url)
      );
      assert.equal(opened, false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('按空行分帧，支持多行 data 并忽略注释和元数据', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.write(': keepalive\n');
      res.write('id: 1\n');
      res.write('event: message\n');
      res.write('data: {"type":"chunk",\n');
      res.write('data: "value":42}\n\n');
      res.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/event';

    try {
      const events = await sseConnect(url);
      assert.deepEqual(events, [{ type: 'chunk', value: 42 }]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
