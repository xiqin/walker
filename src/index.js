#!/usr/bin/env node
'use strict';

const { loadEnvConfig } = require('./config/env');
const { createApp } = require('./app/bootstrap');
const { createLogger } = require('./core/logger');
const daemon = require('./cli/daemon');
const logs = require('./cli/logs');

function printUsage() {
  console.log('walker — IM tool and AI agent CLI multiplexer');
  console.log('');
  console.log('Usage:');
  console.log('  walker              Start walker in foreground (Ctrl+C to stop)');
  console.log('  walker start        Start walker in background (daemon)');
  console.log('  walker stop         Stop background walker');
  console.log('  walker status       Show background walker status and recent logs');
  console.log('  walker logs [N]     Show last N lines of logs (default 80)');
  console.log('  walker help         Show this help');
  console.log('');
  console.log('Logs: logs/walker.out.log and logs/walker.err.log');
}

async function runForeground() {
  const logger = createLogger('walker');
  const config = loadEnvConfig();

  if (!config.feishuAppId || !config.feishuAppSecret) {
    logger.error('missing feishu credentials', {
      source: config.feishuConfigSource,
      hint: 'Set FEISHU_APP_ID and FEISHU_APP_SECRET in .env',
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

  setInterval(() => {}, 60000);

  try {
    await app.start();
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

async function main() {
  const arg = process.argv[2];
  let code;
  switch (arg) {
    case undefined:
    case 'run':
      await runForeground();
      return;
    case 'start':
    case 'daemon':
      code = await daemon.start();
      process.exit(code);
      return;
    case 'stop':
      code = await daemon.stop();
      process.exit(code);
      return;
    case 'status':
      code = await daemon.status();
      process.exit(code);
      return;
    case 'logs':
      code = await logs.run(process.argv.slice(3));
      process.exit(code);
      return;
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      process.exit(0);
      return;
    default:
      console.error('unknown command: ' + arg);
      printUsage();
      process.exit(1);
  }
}

main();
