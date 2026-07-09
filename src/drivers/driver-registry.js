'use strict';

/**
 * Agent 驱动注册表，管理所有可用的 Agent 驱动实例
 */
class DriverRegistry {
  /**
   * 初始化空的驱动注册表
   */
  constructor() {
    this.drivers = {};
  }

  /**
   * 注册一个 Agent 驱动
   * @param {string} name - 驱动名称
   * @param {AgentDriver} driver - 驱动实例
   */
  register(name, driver) {
    this.drivers[name] = driver;
  }

  /**
   * 根据名称获取已注册的驱动
   * @param {string} name - 驱动名称
   * @returns {AgentDriver|null} 驱动实例，不存在则返回 null
   */
  get(name) {
    return this.drivers[name] || null;
  }

  /**
   * 列出所有已注册的驱动名称
   * @returns {string[]} 驱动名称列表
   */
  list() {
    return Object.keys(this.drivers);
  }
}

module.exports = { DriverRegistry };
