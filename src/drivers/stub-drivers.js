'use strict';

const { AgentDriver } = require('./agent-driver');

function stubDriver(name) {
  const driver = new AgentDriver(name);
  const methods = ['ensureReady', 'createSession', 'resumeSession', 'prompt', 'stop', 'delete'];
  for (const method of methods) {
    driver[method] = async function () {
      throw new Error(name + ' driver is not implemented yet. This is a stub for future extension.');
    };
  }
  return driver;
}

function stubClaudeDriver() {
  return stubDriver('claude');
}

function stubCodexDriver() {
  return stubDriver('codex');
}

module.exports = { stubClaudeDriver, stubCodexDriver };
