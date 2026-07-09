'use strict';

const { loadEnvConfig } = require('./config/env');
const { createApp } = require('./app/bootstrap');
const { createLogger } = require('./core/logger');

const logger = createLogger('walker');

async function main() {
  const config = loadEnvConfig();

  if (!config.feishuAppId || !config.feishuAppSecret) {
    logger.error('missing feishu credentials', {
      source: config.feishuConfigSource,
      hint: 'Set FEISHU_APP_ID and FEISHU_APP_SECRET in .env or ~/.cc-connect/config.toml',
    });
    process.exit(1);
  }

  const app = createApp(config);

  const shutdown = () => {
    logger.info('received shutdown signal');
    app.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await app.start();
  } catch (err) {
    logger.error('walker start failed', { error: err.message });
    process.exit(1);
  }
}

main();
