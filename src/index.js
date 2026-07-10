'use strict';

const { loadEnvConfig } = require('./config/env');
const { createApp } = require('./app/bootstrap');
const { createLogger } = require('./core/logger');

const logger = createLogger('walker');

/**
 * Walker 应用入口函数，加载配置、创建应用实例并注册信号处理
 * @returns {Promise<void>}
 */
async function main() {
  const config = loadEnvConfig();

  if (!config.feishuAppId || !config.feishuAppSecret) {
    logger.error('missing feishu credentials', {
      source: config.feishuConfigSource,
      hint: 'Set FEISHU_APP_ID and FEISHU_APP_SECRET in .env',
    });
    process.exit(1);
  }

  const app = createApp(config);

  /**
   * 系统信号处理函数，优雅关闭应用后退出进程
   */
  const shutdown = () => {
    logger.info('received shutdown signal');
    app.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  setInterval(() => {}, 60000);

  try {
    const result = await app.start();
    if (app.adminServer) {
      const status = app.adminServer.getStatus();
      if (status && !status.disabled) {
        logger.info('Admin console: http://' + (status.host || '127.0.0.1') + ':' + (status.port || 8787));
      }
    }
  } catch (err) {
    logger.error('walker start failed', { error: err.message });
    process.exit(1);
  }
}

main();
