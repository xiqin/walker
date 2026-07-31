'use strict';

const os = require('os');
const path = require('path');
const { DriverRegistry } = require('../drivers/driver-registry');
const { loadEnvConfig } = require('../config/env');
const outputTools = require('./cli-output');

function resolveDataDir(env) {
  const targetEnv = env || process.env;
  const homeDir = os.homedir() || targetEnv.USERPROFILE || targetEnv.HOME || '.';
  const value = targetEnv.WALKER_DATA_DIR || path.join(homeDir, '.walker');
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDir, value.slice(2));
  return value;
}

async function run(argv, options) {
  const opts = options || {};
  const output = opts.output || outputTools.createOutput();
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  const nodeVersion = opts.nodeVersion || process.version;
  const registry = opts.registry || new DriverRegistry({ detectorOptions: opts.detectorOptions });
  const suggestions = [];
  let failures = 0;
  let config;

  try {
    config = opts.config || loadEnvConfig({ env });
  } catch (err) {
    failures++;
    config = { admin: { token: env.WALKER_ADMIN_TOKEN || '' }, walkerDefaultCwd: env.WALKER_DEFAULT_CWD || '' };
    suggestions.push('Fix environment configuration: ' + err.message);
  }

  output.write('Walker doctor');
  outputTools.section(output, 'Core');
  outputTools.row(output, 'Node.js', nodeVersion);
  outputTools.row(output, 'Data directory', resolveDataDir(env));
  outputTools.row(output, 'admin token', outputTools.formatPresence(config.admin && config.admin.token));
  outputTools.row(output, 'default cwd', config.walkerDefaultCwd || cwd);
  output.write('Read-only: no configuration, shell profile, service, or third-party secret was modified.');

  outputTools.section(output, 'Platforms');
  const feishuChecks = [
    ['FEISHU_APP_ID', env.FEISHU_APP_ID],
    ['FEISHU_APP_SECRET', env.FEISHU_APP_SECRET],
  ];
  for (const check of feishuChecks) {
    const name = check[0];
    const value = check[1];
    outputTools.row(output, name, outputTools.formatPresence(value));
    if (!value) {
      failures++;
      output.write('  Problem: ' + name + ' is missing.');
      const suggestion = 'Set ' + name + ' in Walker environment or data-dir .env before starting Feishu integration.';
      output.write('  Suggestion: ' + suggestion);
      suggestions.push(suggestion);
    }
  }

  outputTools.section(output, 'Providers');
  let providerStatuses = [];
  try {
    providerStatuses = await registry.listProviderStatuses(opts.detectorOptions);
  } catch (err) {
    failures++;
    output.write('Provider checks failed to run.');
    output.write('  Problem: ' + err.message);
    const suggestion = 'Review provider detector configuration and retry walker doctor.';
    output.write('  Suggestion: ' + suggestion);
    suggestions.push(suggestion);
  }

  outputTools.table(output, ['id', 'label', 'installed', 'healthy', 'version', 'registered'], providerStatuses.map((provider) => [
    provider.id,
    provider.label || provider.id,
    outputTools.formatBool(provider.installed),
    outputTools.formatBool(provider.healthy),
    provider.version || '',
    outputTools.formatBool(provider.registered || provider.driverRegistered),
  ]));

  for (const provider of providerStatuses) {
    const problems = provider.problems || [];
    const providerSuggestions = provider.suggestions || [];
    if (!provider.healthy || problems.length > 0) failures++;
    for (const problem of problems) {
      output.write('  ' + (provider.label || provider.id) + ' Problem: ' + (problem.message || problem.code || String(problem)));
    }
    for (const suggestion of providerSuggestions) {
      output.write('  ' + (provider.label || provider.id) + ' Suggestion: ' + suggestion);
      suggestions.push(suggestion);
    }
  }

  outputTools.section(output, 'Suggestions');
  if (suggestions.length === 0) output.write('- No action required.');
  else outputTools.list(output, Array.from(new Set(suggestions)));

  return failures > 0 ? 1 : 0;
}

module.exports = { run, resolveDataDir };
