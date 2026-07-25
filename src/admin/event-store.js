const MAX_EVENTS = 1000;
const MAX_METRIC_ENTRIES = 1000;
const MINUTE_MS = 60 * 1000;
const METRIC_KEYS = ['messages', 'commands', 'prompts', 'errors', 'cardDeliveries', 'activeTurns', 'timeoutsOrCancels'];

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
      cardDeliveries: 0,
      activeTurns: 0,
      timeoutsOrCancels: 0,
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
 * 查询事件列表，按时间倒序稳定扫描并支持组合过滤
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
  const requestedLimit = filterOpts.limit == null ? MAX_EVENTS : Number(filterOpts.limit);
  const limit = Math.min(Math.max(requestedLimit || MAX_EVENTS, 1), MAX_EVENTS);
  const after = filterOpts.after == null ? null : Number(filterOpts.after);
  const matches = [];

  for (let index = 0; index < state.events.length; index += 1) {
    const event = state.events[index];
    if (filterOpts.level && event.level !== filterOpts.level) continue;
    if (filterOpts.sessionId && event.sessionId !== filterOpts.sessionId) continue;
    if (filterOpts.routeKey && event.routeKey !== filterOpts.routeKey) continue;
    if (filterOpts.type && event.type !== filterOpts.type) continue;
    if (after !== null && event.createdAt <= after) continue;
    matches.push({ event, index });
  }

  matches.sort((left, right) => right.event.createdAt - left.event.createdAt || right.index - left.index);
  return matches.slice(0, limit).map((match) => match.event);
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
 * 将时间戳按 Unix 时间对齐到所在 UTC 分钟
 * @param {number} timestamp - 毫秒时间戳
 * @returns {number} 分钟起点的毫秒时间戳
 */
function minuteStart(timestamp) {
  return Math.floor(timestamp / MINUTE_MS) * MINUTE_MS;
}

/**
 * 创建空指标桶
 * @param {number} minute - 分钟起点时间戳
 * @returns {Object} 空桶对象
 */
function createEmptyBucket(minute) {
  return {
    minute,
    messages: 0,
    commands: 0,
    prompts: 0,
    errors: 0,
    cardDeliveries: 0,
    activeTurns: 0,
    timeoutsOrCancels: 0,
    promptDurationMs: 0,
  };
}

/**
 * 从 store 的 metrics.entries 构建最近 60 个分钟桶统计
 * @param {Object} state - store 实例
 * @returns {Object[]} 桶数组，每个桶含分钟起点时间戳和各指标累计值
 */
function buildBuckets(state, options) {
  const opts = options || {};
  const end = minuteStart(state.now());
  const durationMs = opts.durationMs > 0 ? opts.durationMs : 59 * MINUTE_MS;
  const start = end - durationMs;
  const buckets = [];
  const byMinute = new Map();

  for (let minute = start; minute <= end; minute += MINUTE_MS) {
    const bucket = createEmptyBucket(minute);
    buckets.push(bucket);
    byMinute.set(minute, bucket);
  }

  for (const entry of state.metrics.entries) {
    const minute = minuteStart(entry.createdAt);
    const bucket = byMinute.get(minute);
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
function getMetrics(storeOrNone, options) {
  const state = isStore(storeOrNone) ? storeOrNone : getDefaultStore();
  const durations = state.metrics.promptDurationsMs.slice();
  const totalDuration = durations.reduce((sum, value) => sum + value, 0);
  return {
    messages: state.metrics.messages,
    commands: state.metrics.commands,
    prompts: state.metrics.prompts,
    errors: state.metrics.errors,
    cardDeliveries: state.metrics.cardDeliveries || 0,
    activeTurns: state.metrics.activeTurns || 0,
    timeoutsOrCancels: state.metrics.timeoutsOrCancels || 0,
    promptDurationsMs: durations,
    averagePromptDurationMs: durations.length ? totalDuration / durations.length : 0,
    buckets: buildBuckets(state, options),
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
