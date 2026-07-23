import { element, listen, replace } from '../dom.js';
import { createTabs } from '../components/tabs.js';
import { createFeedback } from '../components/feedback.js';

const DEFAULT_FILTERS = Object.freeze({ after: '', level: '', sessionId: '', routeKey: '', type: '', keyword: '' });

function responseData(response) {
  return response?.data ?? response ?? {};
}

function queryString(filters, keys) {
  const params = new URLSearchParams();
  for (const key of keys) {
    if (filters[key] === '' || filters[key] == null) continue;
    if (key === 'after') {
      const timestamp = new Date(filters[key]).getTime();
      if (Number.isFinite(timestamp) && timestamp >= 0) params.set(key, String(timestamp));
      continue;
    }
    params.set(key, filters[key]);
  }
  return params.toString();
}

function filterTimestamp(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
}

function logText(line) {
  return typeof line === 'string' ? line : line.raw || line.message || JSON.stringify(line);
}

function structuredLog(line) {
  if (line && typeof line === 'object') return line;
  if (typeof line !== 'string') return null;
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function logFieldMatches(line, names, expected) {
  if (!expected) return true;
  const entry = structuredLog(line);
  if (!entry) return false;
  const field = names.find(name => entry[name] != null);
  return Boolean(field) && String(entry[field]) === String(expected);
}

function logMatchesFilters(line, filters) {
  const entry = structuredLog(line);
  const after = filterTimestamp(filters.after);
  if (after !== null) {
    if (!entry) return false;
    const value = entry.createdAt ?? entry.timestamp ?? entry.time ?? entry.ts;
    const timestamp = typeof value === 'number' ? value : new Date(value || '').getTime();
    if (!Number.isFinite(timestamp) || timestamp <= after) return false;
  }
  return logFieldMatches(line, ['sessionId', 'sessionID'], filters.sessionId)
    && logFieldMatches(line, ['routeKey'], filters.routeKey)
    && logFieldMatches(line, ['type'], filters.type);
}

const METRIC_TYPE_KEYS = Object.freeze({
  message: 'messages', messages: 'messages',
  command: 'commands', commands: 'commands',
  prompt: 'prompts', prompts: 'prompts',
  error: 'errors', errors: 'errors',
  averagePromptDurationMs: 'averagePromptDurationMs',
});

function metricSummary(payload, filters) {
  const after = filterTimestamp(filters.after);
  const buckets = Array.isArray(payload.buckets)
    ? payload.buckets.filter(bucket => after === null || Number(bucket.minute) > after)
    : [];
  const requestedType = filters.type ? METRIC_TYPE_KEYS[filters.type] : '';
  const keys = requestedType ? [requestedType] : ['messages', 'commands', 'prompts', 'errors', 'averagePromptDurationMs'];
  const unavailable = [];
  const summary = {};
  for (const key of keys) {
    if (after !== null && key === 'averagePromptDurationMs') {
      unavailable.push(key);
    } else if (after !== null) {
      summary[key] = buckets.reduce((sum, bucket) => sum + (Number(bucket[key]) || 0), 0);
    } else {
      summary[key] = Number(payload[key]) || 0;
    }
  }
  return { after, buckets, requestedType, summary, unavailable };
}

function downloadText(documentRef, name, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = element('a', { document: documentRef, attributes: { href: url, download: name } });
  link.click();
  URL.revokeObjectURL(url);
}

/** 创建活动、日志和指标共享筛选工作区。 */
export function createActivityWorkspace(options = {}) {
  const documentRef = options.document || document;
  const api = options.api;
  const signal = options.signal;
  const isCurrent = options.isCurrent || (() => true);
  const commit = options.commit || (callback => { if (isCurrent()) callback(); });
  const filters = { ...DEFAULT_FILTERS, ...(options.filters || {}) };
  const intervalMs = options.intervalMs || 5000;
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const root = element('section', { document: documentRef, className: 'workspace workspace--activity', attributes: { 'aria-labelledby': 'activity-title' } });
  const heading = element('h1', { document: documentRef, text: '活动与日志', attributes: { id: 'activity-title' } });
  const filterForm = element('form', { document: documentRef, className: 'filter-grid', attributes: { 'aria-label': '活动共享过滤器' } });
  const inputs = new Map();
  const cleanups = [];
  let active = true;
  let timer = null;
  let logRequest = null;
  let followLogs = true;
  let lastLogText = '';

  const filterDefinitions = [
    ['after', '起始时间'], ['level', '级别'], ['sessionId', 'Session'],
    ['routeKey', 'Route'], ['type', '类型'], ['keyword', '关键词'],
  ];
  for (const [key, label] of filterDefinitions) {
    const input = element('input', { document: documentRef, attributes: { name: key, 'aria-label': label, type: key === 'after' ? 'datetime-local' : 'text' } });
    input.value = filters[key] || '';
    cleanups.push(listen(input, 'input', () => setFilter(key, input.value)));
    inputs.set(key, input);
    filterForm.append(element('label', { document: documentRef, text: label }, input));
  }

  const eventsPanel = element('section', { document: documentRef });
  const logsPanel = element('section', { document: documentRef });
  const metricsPanel = element('section', { document: documentRef });
  const eventsFilterNote = element('p', { document: documentRef, text: '筛选说明：起始时间、级别、Session、Route、类型由服务端应用；关键词在当前返回活动中本地生效。' });
  const logsFilterNote = element('p', { document: documentRef, text: '筛选说明：级别、关键词由服务端应用；起始时间、Session、Route、类型在当前返回日志中本地生效。' });
  const metricsFilterNote = element('p', { document: documentRef, text: '筛选说明：指标无服务端筛选；起始时间和可识别的指标类型在分钟桶中本地生效；级别、Session、Route、关键词对指标 DTO 不适用。' });
  const eventsFeedback = createFeedback({ document: documentRef });
  const logsFeedback = createFeedback({ document: documentRef });
  const metricsFeedback = createFeedback({ document: documentRef });
  const logOutput = element('pre', { document: documentRef, className: 'log-output', attributes: { tabindex: '0', 'aria-label': '日志内容' } });
  const refreshButton = element('button', { document: documentRef, text: '刷新日志', attributes: { type: 'button' } });
  const autoRefresh = element('input', { document: documentRef, attributes: { type: 'checkbox', 'aria-label': '自动刷新日志' } });
  const follow = element('input', { document: documentRef, attributes: { type: 'checkbox', 'aria-label': '跟随最新日志' } });
  follow.checked = true;
  const copyButton = element('button', { document: documentRef, text: '复制日志', attributes: { type: 'button' } });
  const downloadButton = element('button', { document: documentRef, text: '下载日志', attributes: { type: 'button' } });
  logsPanel.append(
    logsFilterNote,
    element('div', { document: documentRef, className: 'toolbar' }, refreshButton, element('label', { document: documentRef, text: '自动刷新' }, autoRefresh), element('label', { document: documentRef, text: '跟随滚动' }, follow), copyButton, downloadButton),
    logsFeedback.element,
  );
  eventsPanel.append(eventsFilterNote, eventsFeedback.element);
  metricsPanel.append(metricsFilterNote, metricsFeedback.element);
  let tabsReady = false;
  const tabs = createTabs({
    document: documentRef,
    label: '活动数据类型',
    tabs: [
      { id: 'events', label: '活动', panel: eventsPanel },
      { id: 'logs', label: '日志', panel: logsPanel },
      { id: 'metrics', label: '指标', panel: metricsPanel },
    ],
    onChange: id => { if (active && tabsReady) refreshTab(id); },
  });
  tabsReady = true;
  root.append(heading, filterForm, tabs.element, eventsPanel, logsPanel, metricsPanel);

  function setFilter(key, value) {
    if (Object.hasOwn(DEFAULT_FILTERS, key)) filters[key] = String(value ?? '');
    options.onFiltersChange?.({ ...filters });
  }

  async function refreshEvents() {
    eventsFeedback.showLoading('正在加载活动');
    try {
      const query = queryString(filters, ['after', 'level', 'sessionId', 'routeKey', 'type']);
      const payload = responseData(await api.get('/api/admin/events' + (query ? '?' + query : ''), { signal }));
      const keyword = filters.keyword.trim().toLowerCase();
      const events = (payload.events || []).filter(event => !keyword || String(event.message || '').toLowerCase().includes(keyword));
      commit(() => {
        if (!active) return;
        if (!events.length) return eventsFeedback.showEmpty('暂无活动');
        const list = element('ol', { document: documentRef, className: 'event-list' });
        for (const event of events) list.append(element('li', { document: documentRef, text: [event.timestamp || event.createdAt || '', event.level || '', event.type || '', event.message || ''].filter(Boolean).join(' · ') }));
        eventsFeedback.showContent(list);
      });
    } catch (error) {
      if (error?.code !== 'ABORTED') commit(() => active && eventsFeedback.showError(error, refreshEvents));
    }
  }

  async function refreshLogs() {
    if (!active || logRequest) return logRequest;
    logsFeedback.showLoading('正在读取日志');
    logRequest = (async () => {
      try {
        const query = queryString(filters, ['level', 'keyword']);
        const payload = responseData(await api.get('/api/admin/logs' + (query ? '?' + query : ''), { signal }));
        const lines = Array.isArray(payload.lines) ? payload.lines : Array.isArray(payload) ? payload : String(payload.content || payload.text || '').split('\n');
        lastLogText = lines.filter(line => logMatchesFilters(line, filters)).map(logText).join('\n');
        commit(() => {
          if (!active) return;
          const previousScrollTop = logOutput.scrollTop;
          logOutput.textContent = lastLogText;
          logsFeedback.showContent(logOutput);
          logOutput.scrollTop = followLogs ? logOutput.scrollHeight : previousScrollTop;
        });
      } catch (error) {
        if (error?.code !== 'ABORTED') commit(() => active && logsFeedback.showError(error, refreshLogs));
      } finally {
        logRequest = null;
      }
    })();
    return logRequest;
  }

  async function refreshMetrics() {
    metricsFeedback.showLoading('正在加载指标');
    try {
      const payload = responseData(await api.get('/api/admin/metrics', { signal }));
      const metrics = metricSummary(payload, filters);
      const typeLabel = filters.type || '全部指标';
      const context = metrics.after === null ? '全部 60 分钟指标' : `起始时间 ${filters.after} 之后`;
      const content = {
        context,
        type: typeLabel,
        summary: metrics.summary,
        buckets: metrics.buckets,
      };
      if (filters.type && !metrics.requestedType) content.typeNote = `类型 ${filters.type} 在指标 DTO 中不适用`;
      if (metrics.unavailable.length) content.typeNote = `${metrics.unavailable.join('、')} 无法从时间桶可靠计算，在当前时间过滤下不适用`;
      commit(() => active && metricsFeedback.showContent(element('pre', { document: documentRef, text: `当前过滤上下文：${context}；${typeLabel}\n${JSON.stringify(content, null, 2)}` })));
    } catch (error) {
      if (error?.code !== 'ABORTED') commit(() => active && metricsFeedback.showError(error, refreshMetrics));
    }
  }

  function refreshTab(selected) {
    if (selected === 'logs') return refreshLogs();
    if (selected === 'metrics') return refreshMetrics();
    return refreshEvents();
  }

  function refreshSelected() {
    return refreshTab(tabs.getSelected());
  }

  function setAutoRefresh(enabled) {
    autoRefresh.checked = Boolean(enabled);
    if (timer) clearIntervalFn(timer);
    timer = enabled ? setIntervalFn(() => refreshLogs(), intervalMs) : null;
  }

  function setFollowLogs(enabled) {
    followLogs = Boolean(enabled);
    follow.checked = followLogs;
  }

  cleanups.push(listen(refreshButton, 'click', refreshLogs));
  cleanups.push(listen(autoRefresh, 'change', () => setAutoRefresh(autoRefresh.checked)));
  cleanups.push(listen(follow, 'change', () => setFollowLogs(follow.checked)));
  cleanups.push(listen(copyButton, 'click', () => navigator.clipboard?.writeText(lastLogText)));
  cleanups.push(listen(downloadButton, 'click', () => (options.download || ((name, text) => downloadText(documentRef, name, text)))('walker.log', lastLogText)));

  function cleanup() {
    if (!active) return;
    active = false;
    if (timer) clearIntervalFn(timer);
    timer = null;
    tabs.cleanup();
    for (const dispose of cleanups) dispose();
  }

  return { element: root, tabs, logOutput, setFilter, getFilters: () => Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== '')), refreshEvents, refreshLogs, refreshMetrics, refreshSelected, setAutoRefresh, setFollowLogs, cleanup };
}

/** Router 页面入口。 */
export async function mount(context) {
  const filters = context.store?.getState?.().filters?.activity || {};
  const workspace = createActivityWorkspace({
    ...context,
    document: context.root.ownerDocument || document,
    filters,
    onFiltersChange: value => context.store?.setPageFilters?.('activity', value),
  });
  context.commit(() => replace(context.root, workspace.element));
  await workspace.refreshSelected();
  return workspace.cleanup;
}
