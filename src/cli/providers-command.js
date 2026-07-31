'use strict';

const { DriverRegistry } = require('../drivers/driver-registry');
const outputTools = require('./cli-output');

async function run(argv, options) {
  const args = argv || [];
  const opts = options || {};
  const output = opts.output || outputTools.createOutput();
  const registry = opts.registry || new DriverRegistry({ detectorOptions: opts.detectorOptions });
  const subcommand = args[0] || 'list';

  if (subcommand === 'list') {
    const providers = typeof registry.listProviderStatuses === 'function'
      ? await registry.listProviderStatuses(opts.detectorOptions)
      : registry.listProviders();
    outputTools.section(output, 'Providers');
    outputTools.table(output, ['id', 'label', 'installed', 'healthy', 'version', 'registered'], providers.map((provider) => [
      provider.id,
      provider.label || provider.id,
      provider.installed === undefined ? 'unknown' : outputTools.formatBool(provider.installed),
      provider.healthy === undefined ? 'unknown' : outputTools.formatBool(provider.healthy),
      provider.version || '',
      outputTools.formatBool(provider.registered || provider.driverRegistered),
    ]));
    return 0;
  }

  if (subcommand === 'doctor') {
    const id = args[1];
    if (!id) {
      output.error('missing provider id. Usage: walker providers doctor [id]');
      return 1;
    }
    const result = await registry.doctorProvider(id, opts.detectorOptions);
    if (!result || !result.ok) {
      const message = result && result.error && result.error.message ? result.error.message : 'unknown provider: ' + id;
      output.error(message);
      return 1;
    }
    printProviderDoctor(output, result.provider);
    return result.provider && result.provider.healthy === false ? 1 : 0;
  }

  output.error('unknown providers command: ' + subcommand);
  output.error('Usage: walker providers list | walker providers doctor [id]');
  return 1;
}

function printProviderDoctor(output, provider) {
  outputTools.section(output, 'Provider: ' + provider.id);
  outputTools.row(output, 'label', provider.label || provider.id);
  outputTools.row(output, 'installed', outputTools.formatBool(provider.installed));
  outputTools.row(output, 'healthy', outputTools.formatBool(provider.healthy));
  outputTools.row(output, 'version', provider.version || '');
  outputTools.row(output, 'registered', outputTools.formatBool(provider.registered || provider.driverRegistered));
  outputTools.row(output, 'health', provider.health && provider.health.summary ? provider.health.summary : '');
  if (provider.capabilities) {
    const capabilities = Object.keys(provider.capabilities).filter((key) => provider.capabilities[key]).join(', ');
    outputTools.row(output, 'capabilities', capabilities);
  }
  if (provider.configKeys) outputTools.row(output, 'config keys', provider.configKeys.join(', '));
  for (const problem of provider.problems || []) {
    output.write('Problem: ' + (problem.message || problem.code || String(problem)));
  }
  for (const suggestion of provider.suggestions || []) {
    output.write('Suggestion: ' + suggestion);
  }
}

module.exports = { run, printProviderDoctor };
