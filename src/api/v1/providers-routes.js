'use strict';

const { route, sendOk, sendError, recordApiEvent, recordApiMetric } = require('./common');

function createProviderRoutes(ctx) {
  return [
    route('GET', '/api/v1/providers', async function listProvidersHandler(_req, res) {
      const registry = ctx.registry;
      const providers = registry && typeof registry.listProviderStatuses === 'function'
        ? await registry.listProviderStatuses()
        : registry && typeof registry.listProviders === 'function'
          ? registry.listProviders()
          : [];
      sendOk(res, { providers: sanitize(providers), total: providers.length });
    }),
    route('GET', '/api/v1/providers/:id/doctor', async function doctorProviderHandler(_req, res, params) {
      const registry = ctx.registry;
      if (!registry || typeof registry.doctorProvider !== 'function') {
        sendError(res, 'NOT_FOUND', 'provider doctor unavailable', 404);
        return;
      }
      const result = await registry.doctorProvider(params.id);
      recordApiMetric(ctx, result && result.ok ? 'messages' : 'errors');
      recordApiEvent(ctx, {
        type: result && result.ok ? 'api.v1.provider.doctor' : 'api.v1.error',
        level: result && result.ok ? 'info' : 'error',
        message: 'provider doctor requested',
        data: { providerId: params.id, ok: !!(result && result.ok) },
      });
      if (!result || result.ok === false) {
        const err = result && result.error ? result.error : { code: 'NOT_FOUND', message: 'provider not found' };
        sendError(res, err.code || 'NOT_FOUND', err.message || 'provider not found', err.code === 'BAD_REQUEST' ? 400 : 404);
        return;
      }
      sendOk(res, sanitize(result));
    }),
  ];
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/secret|token|password|credential|key/i.test(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = sanitize(item);
    }
  }
  return out;
}

module.exports = { createProviderRoutes, sanitizeProviderValue: sanitize };
