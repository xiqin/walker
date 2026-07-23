/** 页面可稳定识别的统一 API 错误。 */
export class ApiError extends Error {
  /** 创建标准错误对象。 */
  constructor(code, message, status = 0, details = null, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** 将外部 signal 转接到当前请求控制器。 */
function forwardAbort(signal, controller) {
  if (!signal) return () => {};
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

/** 尝试读取 JSON，返回内容类型是否符合约定。 */
async function readResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return { json: false, data: null };
  try {
    return { json: true, data: await response.json() };
  } catch (error) {
    throw new ApiError('INVALID_RESPONSE', '服务返回了无效 JSON', response.status, null, error);
  }
}

/** 创建统一处理认证、超时、取消、JSON 和 busy 的 API client。 */
export function createApiClient(options = {}) {
  const fetchImpl = options.fetch || fetch;
  const getToken = options.getToken || (() => null);
  const onUnauthorized = options.onUnauthorized || (() => {});
  const setBusy = options.setBusy || (() => {});
  const defaultTimeout = options.timeout == null ? 15000 : options.timeout;

  /** 发起一个标准 API 请求。 */
  async function request(method, url, requestOptions = {}) {
    const controller = new AbortController();
    const timeout = requestOptions.timeout == null ? defaultTimeout : requestOptions.timeout;
    const stopForwarding = forwardAbort(requestOptions.signal, controller);
    const timer = timeout > 0 ? setTimeout(() => controller.abort(new Error('timeout')), timeout) : null;
    const headers = { Accept: 'application/json', ...(requestOptions.headers || {}) };
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    const init = { method, headers, signal: controller.signal };
    if (requestOptions.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(requestOptions.body);
    }
    setBusy(true);
    try {
      const response = await fetchImpl(url, init);
      const { json, data } = await readResponse(response);
      if (response.status === 401) {
        onUnauthorized();
        throw new ApiError('UNAUTHORIZED', data?.error?.message || '登录状态已失效', 401, data);
      }
      if (!json) {
        throw new ApiError('INVALID_RESPONSE', '服务返回了非 JSON 响应', response.status);
      }
      if (!response.ok) {
        const payload = data?.error || data || {};
        throw new ApiError(payload.code || 'HTTP_ERROR', payload.message || '请求失败', response.status, payload.details || data);
      }
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (controller.signal.aborted) {
        const externalAbort = requestOptions.signal?.aborted;
        throw new ApiError(externalAbort ? 'ABORTED' : 'TIMEOUT', externalAbort ? '请求已取消' : '请求超时', 0, null, error);
      }
      throw new ApiError('NETWORK_ERROR', error.message || '网络请求失败', 0, null, error);
    } finally {
      if (timer) clearTimeout(timer);
      stopForwarding();
      setBusy(false);
    }
  }

  return {
    request,
    get: (url, options) => request('GET', url, options),
    post: (url, body, options = {}) => request('POST', url, { ...options, body }),
    patch: (url, body, options = {}) => request('PATCH', url, { ...options, body }),
    delete: (url, options) => request('DELETE', url, options),
  };
}
