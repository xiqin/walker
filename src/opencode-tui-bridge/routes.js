'use strict';

const { parseBody, isAuthenticated } = require('../admin/auth');
const { success, error, send } = require('../admin/response');
const { isLoopback } = require('../opencode-hook/receiver');

function createTuiBridgeRoutes(ctx) {
  const bridge = ctx.bridge;
  const config = ctx.config || { token: '' };

  function route(pattern, action) {
    return {
      method: 'POST',
      pattern,
      handler: async function tuiBridgeHandler(req, res) {
        if (!isLoopback(req)) {
          send(res, error('FORBIDDEN', 'only loopback requests are accepted'), 403);
          return;
        }
        if (config.token && !isAuthenticated(req, config)) {
          send(res, error('UNAUTHORIZED', '需要有效的管理端 token'), 401);
          return;
        }
        let body;
        try {
          body = await parseBody(req);
        } catch (err) {
          send(res, error(err.code || 'BAD_REQUEST', err.message || '无效请求体'), err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400);
          return;
        }
        if (!body) {
          send(res, error('BAD_REQUEST', '无效请求体'), 400);
          return;
        }
        try {
          send(res, success(action(body) || {}));
        } catch (err) {
          send(res, error('BAD_REQUEST', err.message), 400);
        }
      },
    };
  }

  return [
    route('/opencode/tui-bridge/register', (body) => bridge.register(body)),
    route('/opencode/tui-bridge/poll', (body) => ({ delivery: bridge.poll(body) })),
    route('/opencode/tui-bridge/events', (body) => bridge.reportEvents(body)),
    route('/opencode/tui-bridge/dispose', (body) => { bridge.dispose(body); return { disposed: true }; }),
  ];
}

module.exports = { createTuiBridgeRoutes };
