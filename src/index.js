#!/usr/bin/env node
'use strict';

const { loadEnvConfig } = require('./config/env');
const { createApp } = require('./app/bootstrap');
const { createLogger } = require('./core/logger');
const daemon = require('./cli/daemon');
const logs = require('./cli/logs');
const doctorCommand = require('./cli/doctor-command');
const providersCommand = require('./cli/providers-command');
const initCommand = require('./cli/init-command');
const cliOutput = require('./cli/cli-output');

function printUsage(output) {
  const out = output || cliOutput.createOutput();
  out.write('walker — IM tool and AI agent CLI multiplexer');
  out.write('');
  out.write('Usage:');
  out.write('  walker              Start walker in foreground (Ctrl+C to stop)');
  out.write('  walker start        Start walker in background (daemon)');
  out.write('  walker stop         Stop background walker');
  out.write('  walker status       Show background walker status and recent logs');
  out.write('  walker logs [N]     Show last N lines of logs (default 80)');
  out.write('  walker doctor       Run read-only diagnostics');
  out.write('  walker providers list           List available providers');
  out.write('  walker providers doctor [id]    Diagnose provider');
  out.write('  walker init         Initialize Walker data directory and config');
  out.write('  walker help         Show this help');
  out.write('');
  out.write('Logs: ' + daemon.OUT_LOG + ' and ' + daemon.ERR_LOG);
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

async function main(argv, options) {
  const args = argv || process.argv.slice(2);
  const opts = options || {};
  const output = opts.output || cliOutput.createOutput();
  const exit = opts.exit || process.exit.bind(process);
  const arg = args[0];
  let code;
  switch (arg) {
    case undefined:
    case 'run':
      await runForeground();
      return;
    case 'start':
    case 'daemon':
      code = await daemon.start();
      exit(code);
      return;
    case 'stop':
      code = await daemon.stop();
      exit(code);
      return;
    case 'status':
      code = await daemon.status();
      exit(code);
      return;
    case 'logs':
      code = await logs.run(args.slice(1));
      exit(code);
      return;
    case 'doctor':
      code = await doctorCommand.run(args.slice(1), opts);
      exit(code);
      return;
    case 'providers':
      code = await providersCommand.run(args.slice(1), opts);
      exit(code);
      return;
    case 'init':
      code = await initCommand.run(args.slice(1), opts);
      exit(code);
      return;
    case 'help':
    case '--help':
    case '-h':
      printUsage(output);
      exit(0);
      return;
    default:
      output.error('unknown command: ' + arg);
      printUsage(output);
      exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, printUsage, runForeground };
