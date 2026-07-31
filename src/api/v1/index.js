'use strict';

const { attachContext } = require('./common');
const { createProviderRoutes } = require('./providers-routes');
const { createSessionRoutes } = require('./sessions-routes');
const { createRoutesRoutes } = require('./routes-routes');
const { createPromptRoutes } = require('./prompt-routes');
const { createEventsRoutes } = require('./events-routes');

function createApiV1Routes(appContext) {
  const ctx = appContext || {};
  return attachContext([
    ...createProviderRoutes(ctx),
    ...createSessionRoutes(ctx),
    ...createRoutesRoutes(ctx),
    ...createPromptRoutes(ctx),
    ...createEventsRoutes(ctx),
  ], ctx);
}

module.exports = { createApiV1Routes };
