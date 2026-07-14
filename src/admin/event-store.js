const MAX_EVENTS = 1000;
const MAX_METRIC_ENTRIES = 1000;
const HOUR_MS = 60 * 60 * 1000;
const METRIC_KEYS = ['messages', 'commands', 'prompts', 'errors'];

/**
 * 创建独立事件指标存储实例
 * @param {Object} [options] - 可选配置
 * @param {Function} [options.now] - 时间函数，默认 Date.now
 * @returns {Object} store 实例
 */
function createEventStore(options) {
  const opts = options || {};
  return {
    events: [],
    metrics: {
      messages: 0,
      commands: 0,
      prompts: 0,
      errors: 0,
      promptDurationsMs: [],
      entries: [],
    },
    now: opts.now || Date.now,
    nextEventId: 1,
  };
}

/**
 * 获取或创建全局默认内存 store（单例）
 * @returns {Object} 默认 store 实例
 */
function getDefaultStore() {
  if (!getDefaultStore.store) {
    getDefaultStore.store = createEventStore();
  }
  return getDefaultStore.store;
}

function resolveStore(store) {
  return store && Array.isArray(store.events) ? store : getDefaultStore();
}

/**
 * 判断参数是否为 store 实例（含 events 数组）
 * @param {*} val - 待判断值
 * @returns {boolean}
 */
function isStore(val) {
  return val && Array.isArray(val.events);
}

/**
 * 记录事件到 store，超出 MAX_EVENTS 时裁剪最旧条目
 * 省略 store 参数时自动使用默认内存 store
 * @param {Object} [storeOrEvent] - store 实例或事件对象
 * @param {Object} [maybeEvent] - 事件对象（仅当第一个参数为 store 时传入）
 * @returns {Object} 记录的事件条目
 */
function recordEvent(storeOrEvent, maybeEvent) {
  const hasStore = isStore(storeOrEvent);
  const state = hasStore ? storeOrEvent : getDefaultStore();
  const event = hasStore ? maybeEvent : storeOrEvent;
  const payload = event || {};
  const createdAt = payload.createdAt || state.now();
  const item = {
    id: payload.id || `evt_${state.nextEventId}`,
    type: payload.type || 'admin.action',
    level: payload.level || 'info',
    sessionId: payload.sessionId || '',
    routeKey: payload.routeKey || '',
    message: payload.message || '',
    data: payload.data || {},
    createdAt,
  };

  state.nextEventId += 1;
  state.events.push(item);
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  return item;
}

/**
 * 查询事件列表，支持按类型过滤和限制返回条数
 * 省略 store 参数时自动使用默认内存 store
 * @param {Object} [storeOrOpts] - store 实例或过滤选项
 * @param {Object} [maybeOpts] - 过滤选项（仅当第一个参数为 store 时传入）
 * @returns {Object[]} 事件列表
 */
function listEvents(storeOrOpts, maybeOpts) {
  const hasStore = isStore(storeOrOpts);
  const state = hasStore ? storeOrOpts : getDefaultStore();
  const opts = hasStore ? maybeOpts : storeOrOpts;
  const filterOpts = opts || {};
  let events = state.events;
  if (filterOpts.type) {
    events = events.filter((event) => event.type === filterOpts.type);
  }
  if (filterOpts.limit) {
    events = events.slice(-filterOpts.limit);
  }
  return events.slice();
}

/**
 * 记录指标计数或 prompt 耗时到 store
 * 省略 store 参数时自动使用默认内存 store
 * @param {Object|string} [storeOrName] - store 实例或指标名称
 * @param {string|number} [nameOrValue] - 指标名称或增量值
 * @param {number} [valueOrTime] - 增量值或时间戳
 * @param {number} [maybeCreatedAt] - 时间戳（仅当第一个参数为 store 时传入）
 */
function recordMetric(storeOrName, nameOrValue, valueOrTime, maybeCreatedAt) {
  const hasStore = isStore(storeOrName);
  const state = hasStore ? storeOrName : getDefaultStore();
  const metricName = hasStore ? nameOrValue : storeOrName;
  const amount = hasStore ? (valueOrTime === undefined ? 1 : Number(valueOrTime)) : (nameOrValue === undefined ? 1 : Number(nameOrValue));
  const timestamp = hasStore ? (maybeCreatedAt || state.now()) : (valueOrTime || state.now());

  if (METRIC_KEYS.includes(metricName)) {
    state.metrics[metricName] += Number.isFinite(amount) ? amount : 1;
  } else if (metricName === 'promptDurationMs') {
    state.metrics.promptDurationsMs.push(Number.isFinite(amount) ? amount : 0);
    if (state.metrics.promptDurationsMs.length > MAX_METRIC_ENTRIES) {
      state.metrics.promptDurationsMs.splice(0, state.metrics.promptDurationsMs.length - MAX_METRIC_ENTRIES);
    }
  } else {
    throw new Error(`Unknown metric ${metricName}`);
  }

  state.metrics.entries.push({ name: metricName, value: Number.isFinite(amount) ? amount : 1, createdAt: timestamp });
  if (state.metrics.entries.length > MAX_METRIC_ENTRIES) {
    state.metrics.entries.splice(0, state.metrics.entries.length - MAX_METRIC_ENTRIES);
  }
}

/**
 * 将时间戳对齐到所在整点小时
 * @param {number} timestamp - 毫秒时间戳
 * @returns {number} 整点小时毫秒时间戳
 */
function hourStart(timestamp) {
  const date = new Date(timestamp);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

/**
 * 创建空指标桶
 * @param {number} hour - 整点小时时间戳
 * @returns {Object} 空桶对象
 */
function createEmptyBucket(hour) {
  return {
    minute: hour,
    messages: 0,
    commands: 0,
    prompts: 0,
    errors: 0,
    promptDurationMs: 0,
  };
}

/**
 * 从 store 的 metrics.entries 构建 60 小时桶统计
 * @param {Object} state - store 实例
 * @returns {Object[]} 桶数组，每个桶含整点时间戳和各指标累计值
 */
function buildBuckets(state) {
  const end = hourStart(state.now());
  const start = end - (59 * HOUR_MS);
  const buckets = [];
  const byHour = new Map();

  for (let hour = start; hour <= end; hour += HOUR_MS) {
    const bucket = createEmptyBucket(hour);
    buckets.push(bucket);
    byHour.set(hour, bucket);
  }

  for (const entry of state.metrics.entries) {
    const hour = hourStart(entry.createdAt);
    const bucket = byHour.get(hour);
    if (!bucket) continue;
    if (METRIC_KEYS.includes(entry.name)) {
      bucket[entry.name] += entry.value;
    } else if (entry.name === 'promptDurationMs') {
      bucket.promptDurationMs += entry.value;
    }
  }

  return buckets;
}

/**
 * 获取指标汇总：计数、平均耗时和 60 分钟桶
 * 省略 store 参数时自动使用默认内存 store
 * @param {Object} [storeOrNone] - store 实例或空
 * @returns {Object} 指标汇总对象
 */
function getMetrics(storeOrNone) {
  const state = isStore(storeOrNone) ? storeOrNone : getDefaultStore();
  const durations = state.metrics.promptDurationsMs.slice();
  const totalDuration = durations.reduce((sum, value) => sum + value, 0);
  return {
    messages: state.metrics.messages,
    commands: state.metrics.commands,
    prompts: state.metrics.prompts,
    errors: state.metrics.errors,
    promptDurationsMs: durations,
    averagePromptDurationMs: durations.length ? totalDuration / durations.length : 0,
    buckets: buildBuckets(state),
  };
}

/**
 * 查询指定 session 的事件时间线
 * 省略 store 参数时自动使用默认内存 store
 * @param {Object|string} [storeOrSessionId] - store 实例或 session ID
 * @param {string|Object} [sessionIdOrOpts] - session ID 或过滤选项
 * @param {Object} [maybeOpts] - 过滤选项
 * @returns {Object[]} 该 session 的事件列表
 */
function timelineForSession(storeOrSessionId, sessionIdOrOpts, maybeOpts) {
  const hasStore = isStore(storeOrSessionId);
  const sessionId = hasStore ? sessionIdOrOpts : storeOrSessionId;
  const opts = hasStore ? maybeOpts : undefined;
  return listEvents(hasStore ? storeOrSessionId : undefined, opts).filter((event) => event.sessionId === sessionId);
}

module.exports = {
  createEventStore,
  recordEvent,
  listEvents,
  recordMetric,
  getMetrics,
  timelineForSession,
};
