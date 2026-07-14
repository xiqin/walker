'use strict';

const http = require('http');
const https = require('https');

/**
 * 发送 HTTP/HTTPS 请求并返回 JSON 响应，支持自定义头部
 * @param {string} method - HTTP 方法（GET/POST/PATCH/DELETE 等）
 * @param {string} url - 请求 URL
 * @param {Object|null} body - 请求体对象，为 null 时不发送
 * @param {Object} [extraHeaders] - 额外请求头部
 * @param {Object} [requestOptions] - 请求选项
 * @param {number} [requestOptions.timeoutMs] - 请求最大等待时间，超时后拒绝
 * @returns {Promise<Object>} 包含 status 和 data 的响应对象
 */
function httpRequest(method, url, body, extraHeaders, requestOptions) {
  const parsed = new URL(url);
  const client = parsed.protocol === 'https:' ? https : http;
  const isBody = body !== null && body !== undefined;
  const headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
  const timeoutMs = requestOptions && requestOptions.timeoutMs;
  const options = {
    method,
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.pathname + parsed.search,
    headers,
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        cleanup();
      let parsedData = {};
      try {
        parsedData = JSON.parse(data);
      } catch (e) {
        if (data && data.length > 0) {
          console.error(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'warn',
            scope: 'http-helper',
            message: 'response JSON parse failed',
            statusCode: res.statusCode,
            bodyLength: data.length,
            bodyPreview: data.slice(0, 200),
          }));
        }
      }
      resolve({ status: res.statusCode, data: parsedData });
      });
    });
    req.on('error', fail);
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        const err = new Error(method + ' ' + url + ' timed out after ' + timeoutMs + 'ms');
        req.destroy(err);
        fail(err);
      }, timeoutMs);
    }
    if (isBody) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * 连接 SSE 事件流并收集所有 JSON 事件数据
 * @param {string} url - SSE 流地址
 * @param {Object} [extraHeaders] - 额外请求头部
 * @param {Object} [options] - 连接选项
 * @param {Function} [options.shouldClose] - 收到事件后是否主动关闭连接
 * @param {Function} [options.onOpen] - SSE 响应头建立后触发
 * @param {Function} [options.onEvent] - 每个 JSON 事件解析后触发
 * @param {number} [options.timeoutMs] - 连接最大等待时间，超时后拒绝
 * @param {AbortSignal} [options.signal] - 外部取消信号
 * @param {boolean} [options.collectEvents=true] - 是否收集事件并在结束时返回
 * @returns {Promise<Object[]>} 解析后的 JSON 事件数组
 */
function sseConnect(url, extraHeaders, options) {
  const parsed = new URL(url);
  const client = parsed.protocol === 'https:' ? https : http;
  const headers = Object.assign({ Accept: 'text/event-stream' }, extraHeaders || {});
  const shouldClose = options && options.shouldClose;
  const onOpen = options && options.onOpen;
  const onEvent = options && options.onEvent;
  const timeoutMs = options && options.timeoutMs;
  const signal = options && options.signal;
  const collectEvents = !options || options.collectEvents !== false;

  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let activeRes;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (signal) signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      if (req && req.destroy) req.destroy();
      finish([], activeRes);
    };
    const finish = (events, res) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(events);
      if (res && res.destroy) res.destroy();
      if (req && req.destroy) req.destroy();
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
      if (activeRes && activeRes.destroy) activeRes.destroy();
      if (req && req.destroy) req.destroy();
    };
    const requestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers,
    };

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        fail(new Error('SSE connection timed out after ' + timeoutMs + 'ms'));
      }, timeoutMs);
    }

    if (signal) {
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
    }

    req = client.request(requestOptions, (res) => {
      activeRes = res;
      const statusCode = res.statusCode || 0;
      const contentType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (statusCode < 200 || statusCode >= 300) {
        fail(new Error('SSE request to ' + url + ' failed with status ' + statusCode));
        return;
      }
      if (contentType !== 'text/event-stream') {
        fail(new Error('SSE request to ' + url + ' expected text/event-stream but received ' + (res.headers['content-type'] || 'missing content-type')));
        return;
      }
      if (onOpen) {
        try { onOpen(res); } catch (_) {}
      }
      const events = [];
      let buffer = '';
      let eventLines = [];
      const MAX_BUFFER_SIZE = 10 * 1024 * 1024;
      const MAX_EVENTS = 10000;

      const dispatchEvent = () => {
        const dataLines = [];
        for (const line of eventLines) {
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'data') dataLines.push(value);
        }
        eventLines = [];
        if (dataLines.length === 0) return false;

        try {
          const event = JSON.parse(dataLines.join('\n'));
          if (collectEvents) events.push(event);
          if (onEvent) {
            try { onEvent(event, events); } catch (_) {}
          }
          if (shouldClose && shouldClose(event, events)) {
            finish(events, res);
            return true;
          }
        } catch (_) {}
        return false;
      };

      const processLine = (line) => {
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') return dispatchEvent();
        eventLines.push(line);
        return false;
      };

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > MAX_BUFFER_SIZE || (collectEvents && events.length > MAX_EVENTS)) {
          fail(new Error('SSE stream exceeded max buffer/event limit'));
          return;
        }
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (processLine(line)) return;
        }
      });

      res.on('end', () => {
        if (buffer) processLine(buffer);
        if (eventLines.length > 0) dispatchEvent();
        finish(events, res);
      });
    });
    req.on('error', (err) => {
      fail(err);
    });
    req.end();
  });
}

module.exports = { httpRequest, sseConnect };
