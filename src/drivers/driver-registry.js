'use strict';

const { createLogger } = require('../core/logger');
const { getProviderCatalog, listProviderCatalog } = require('../providers/provider-catalog');
const providerHealth = require('../providers/provider-health');
const logger = createLogger('driver-registry');

/**
 * Agent 驱动注册表，管理所有可用的 Agent 驱动实例
 */
class DriverRegistry {
  /**
   * 初始化空的驱动注册表
   */
  constructor(options) {
    const opts = options || {};
    this.drivers = {};
    this.detectorOptions = opts.detectorOptions || {};
  }

  /**
   * 注册一个 Agent 驱动
   * @param {string} name - 驱动名称
   * @param {AgentDriver} driver - 驱动实例
   */
  register(name, driver) {
    if (this.drivers[name]) {
      logger.warn('driver already registered, overwriting', { name });
    }
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

  /**
   * 列出 provider catalog，并标记当前 driver 注册状态。
   * @returns {Object[]} provider 元信息列表。
   */
  listProviders() {
    return listProviderCatalog().map((provider) => this._attachRegistration(provider));
  }

  /**
   * 查询单个 provider 元信息，并标记当前 driver 注册状态。
   * @param {string} id - provider id。
   * @returns {Object|null} provider 元信息，不存在返回 null。
   */
  getProviderMetadata(id) {
    const provider = getProviderCatalog(id);
    return provider ? this._attachRegistration(provider) : null;
  }

  /**
   * 检测单个 provider 状态，并附加 registry 注册状态。
   * @param {string} id - provider id。
   * @param {Object} [options] - 检测依赖覆盖。
   * @returns {Promise<Object>} provider doctor 结果。
   */
  async doctorProvider(id, options) {
    const opts = { ...this.detectorOptions, ...(options || {}) };
    const result = await providerHealth.doctorProvider(id, opts);
    if (result.ok) result.provider = this._attachRegistration(result.provider);
    return result;
  }

  /**
   * 检测所有 provider 状态，并附加 registry 注册状态。
   * @param {Object} [options] - 检测依赖覆盖。
   * @returns {Promise<Object[]>} provider 状态列表。
   */
  async listProviderStatuses(options) {
    const opts = { ...this.detectorOptions, ...(options || {}) };
    const statuses = await providerHealth.listProviderStatuses(opts);
    return statuses.map((status) => this._attachRegistration(status));
  }

  /**
   * 注销指定名称的驱动
   * @param {string} name - 驱动名称
   */
  unregister(name) {
    delete this.drivers[name];
  }

  /**
   * 清空所有已注册的驱动
   */
  clear() {
    this.drivers = {};
  }

  /**
   * 给 provider/status 对象附加 driver 注册状态。
   * @param {Object} provider - provider 元信息或检测状态。
   * @returns {Object} 附加注册状态后的副本。
   */
  _attachRegistration(provider) {
    const registered = !!this.drivers[provider.driver];
    return { ...provider, registered, driverRegistered: registered };
  }
}

module.exports = { DriverRegistry };
