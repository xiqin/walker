'use strict';

const http = require('http');
const https = require('https');

/**
 * 发送 HTTP/HTTPS 请求并返回 JSON 响应，支持自定义头部
 * @param {string} method - HTTP 方法（GET/POST/PATCH/DELETE 等）
 * @param {string} url - 请求 URL
 * @param {Object|null} body - 请求体对象，为 null 时不发送
 * @param {Object} [extraHeaders] - 额外请求头部
 * @returns {Promise<Object>} 包含 status 和 data 的响应对象
 */
function httpRequest(method, url, body, extraHeaders) {
  const parsed = new URL(url);
  const client = parsed.protocol === 'https:' ? https : http;
  const isBody = body !== null && body !== undefined;
  const headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
  const options = {
    method,
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.pathname + parsed.search,
    headers,
  };

  return new Promise((resolve, reject) => {
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsedData = {};
        try { parsedData = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, data: parsedData });
      });
    });
    req.on('error', reject);
    if (isBody) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * 连接 SSE 事件流并收集所有 JSON 事件数据
 * @param {string} url - SSE 流地址
 * @param {Object} [extraHeaders] - 额外请求头部
 * @returns {Promise<Object[]>} 解析后的 JSON 事件数组
 */
function sseConnect(url, extraHeaders) {
  const parsed = new URL(url);
  const client = parsed.protocol === 'https:' ? https : http;
  const headers = Object.assign({ Accept: 'text/event-stream' }, extraHeaders || {});

  return new Promise((resolve, reject) => {
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers,
    };

    const req = client.request(options, (res) => {
      const events = [];
      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data:')) {
            try {
              events.push(JSON.parse(line.slice(5).trim()));
            } catch (_) {}
          }
        }
      });

      res.on('end', () => resolve(events));
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { httpRequest, sseConnect };
