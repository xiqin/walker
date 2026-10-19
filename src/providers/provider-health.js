'use strict';

const { getProviderCatalog, listProviderCatalog } = require('./provider-catalog');
const { detectProvider } = require('./provider-detectors');

/**
 * 查询单个 provider 的结构化检测结果。
 * @param {string} id - provider id。
 * @param {Object} [options] - 检测依赖和 catalog 覆盖。
 * @returns {Promise<Object>} doctor 结果。
 */
async function doctorProvider(id, options) {
  const opts = options || {};
  const provider = opts.provider || getProviderCatalog(id);
  if (!provider) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'unknown provider: ' + id } };
  }

  try {
    const status = opts.detectProvider ? await opts.detectProvider(provider) : await detectProvider(provider, opts);
    return { ok: true, provider: status };
  } catch (err) {
    return { ok: true, provider: createExceptionStatus(provider, err) };
  }
}

/**
 * 列出所有 provider 状态，单项异常被转换为结构化失败项。
 * @param {Object} [options] - 检测依赖和 provider 列表覆盖。
 * @returns {Promise<Object[]>} provider 状态列表。
 */
async function listProviderStatuses(options) {
  const opts = options || {};
  const providers = opts.providers || listProviderCatalog();
  const results = [];
  for (const provider of providers) {
    const result = await doctorProvider(provider.id, { ...opts, provider });
    if (result.ok) results.push(result.provider);
    else results.push(createExceptionStatus(provider, new Error(result.error.message)));
  }
  return results;
}

/**
 * 把检测异常转换成不会中断主流程的 provider 状态。
 * @param {Object} provider - provider catalog 元信息。
 * @param {Error} err - 捕获的异常。
 * @returns {Object} 结构化失败状态。
 */
function createExceptionStatus(provider, err) {
  return {
    id: provider.id,
    label: provider.label,
    driver: provider.driver,
    capabilities: { ...provider.capabilities },
    configKeys: provider.configKeys.slice(),
    installed: false,
    executablePath: '',
    version: '',
    healthy: false,
    health: { status: 'failed', summary: err.message },
    problems: [{ code: 'DETECTOR_EXCEPTION', message: err.message }],
    suggestions: ['Review ' + provider.label + ' installation and Walker provider configuration.'],
  };
}

module.exports = { doctorProvider, listProviderStatuses, createExceptionStatus };
