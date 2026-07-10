'use strict';

const { AgentDriver } = require('./agent-driver');

/**
 * 创建指定名称的占位驱动，所有方法均抛出"未实现"错误
 * @param {string} name - 驱动名称
 * @returns {AgentDriver} 占位驱动实例
 */
function stubDriver(name) {
  const driver = new AgentDriver(name);
  const methods = ['ensureReady', 'createSession', 'resumeSession', 'listSessions', 'prompt', 'stop', 'delete'];
  for (const method of methods) {
    driver[method] = async function () {
      throw new Error(name + ' driver is not implemented yet. This is a stub for future extension.');
    };
  }
  return driver;
}

/**
 * 创建 Claude Agent 的占位驱动
 * @returns {AgentDriver} Claude 占位驱动实例
 */
function stubClaudeDriver() {
  return stubDriver('claude');
}

/**
 * 创建 Codex Agent 的占位驱动
 * @returns {AgentDriver} Codex 占位驱动实例
 */
function stubCodexDriver() {
  return stubDriver('codex');
}

module.exports = { stubClaudeDriver, stubCodexDriver };
