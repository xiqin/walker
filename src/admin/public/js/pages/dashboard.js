import { element, listen } from '../dom.js';
import { formatDateTime, shortId } from '../format.js';
import { createFeedback } from '../components/feedback.js';
import { createStatusCard } from '../components/status-card.js';
import { createDataTable } from '../components/data-table.js';

const STATUS_LABELS = {
  walker: 'Walker',
  feishu: '飞书',
  opencode: 'OpenCode',
  tuiBridge: 'TUI Bridge',
  runtimes: 'Runtime',
  watchers: 'Watcher',
  health: 'Health',
  admin: 'Admin',
};
const SEVERITY = { failed: 0, error: 0, warning: 1, unknown: 2, healthy: 3 };

/** 挂载异常优先的运行总览。 */
export async function mount(context) {
  const documentRef = context.document || document;
  const page = element('div', { document: documentRef, className: 'page dashboard-page' });
  page.append(element('header', { document: documentRef, className: 'page-header' },
    element('h1', { document: documentRef, text: '控制台' }),
    element('p', { document: documentRef, className: 'muted', text: '优先处理异常，再查看会话活动与趋势。' })));
  const regions = {
    status: createRegion(documentRef, '服务状态'),
    issues: createRegion(documentRef, '需处理问题'),
    summary: createRegion(documentRef, '会话摘要'),
    activity: createRegion(documentRef, '近期活动'),
    trend: createRegion(documentRef, '最近 60 分钟趋势'),
    active: createRegion(documentRef, '活跃 Session'),
  };
  page.append(regions.issues.section, regions.status.section, regions.summary.section,
    regions.activity.section, regions.trend.section, regions.active.section);
  context.root.replaceChildren(page);
  Object.values(regions).forEach(region => region.feedback.showLoading());

  const requests = {
    status: context.api.get('/api/admin/status', { signal: context.signal }),
    sessions: context.api.get('/api/admin/sessions', { signal: context.signal }),
    routes: context.api.get('/api/admin/routes', { signal: context.signal }),
    events: context.api.get('/api/admin/events?limit=8', { signal: context.signal }),
    metrics: context.api.get('/api/admin/metrics', { signal: context.signal }),
  };
  const entries = await Promise.all(Object.entries(requests).map(async ([name, request]) => {
    try {
      return [name, { value: unwrap(await request) }];
    } catch (error) {
      return [name, { error }];
    }
  }));
  if (!context.isCurrent()) return;
  const result = Object.fromEntries(entries);
  context.commit(() => renderDashboard(documentRef, context, regions, result));
}

function createRegion(documentRef, title) {
  const feedback = createFeedback({ document: documentRef });
  const section = element('section', { document: documentRef, className: 'workspace-section' },
    element('h2', { document: documentRef, text: title }), feedback.element);
  return { section, feedback };
}

function renderDashboard(documentRef, context, regions, result) {
  renderStatus(documentRef, regions.status.feedback, result.status);
  renderIssues(documentRef, context, regions.issues.feedback, result.status, result.events);
  renderSummary(documentRef, regions.summary.feedback, result.sessions, result.routes);
  renderActivity(documentRef, context, regions.activity.feedback, result.events);
  renderTrend(documentRef, regions.trend.feedback, result.metrics);
  renderActiveSessions(documentRef, context, regions.active.feedback, result.sessions);
}

function renderStatus(documentRef, feedback, state) {
  if (state.error) return feedback.showError(state.error);
  const grid = element('div', { document: documentRef, className: 'status-grid' });
  const entries = Object.entries(state.value || {}).sort((left, right) =>
    (SEVERITY[left[1]?.status] ?? 2) - (SEVERITY[right[1]?.status] ?? 2));
  for (const [name, item] of entries) {
    grid.append(createStatusCard({
      document: documentRef,
      title: STATUS_LABELS[name] || name,
      status: item.status,
      description: item.reason || '',
      details: [['最近检查', formatDateTime(item.checkedAt)]],
    }));
  }
  feedback.showContent(grid);
}

function renderIssues(documentRef, context, feedback, statusState, eventsState) {
  const issues = [];
  if (statusState.value) {
    let order = 0;
    for (const [name, item] of Object.entries(statusState.value)) {
      if (item.status === 'healthy') continue;
      issues.push({
        severity: SEVERITY[item.status] ?? 2,
        order: order++,
        title: STATUS_LABELS[name] || name,
        reason: item.reason || '状态不可用',
        target: item.action?.target || '#connections',
        action: '处理问题',
        identifier: STATUS_LABELS[name] || name,
      });
    }
  }
  for (const event of normalizeEvents(eventsState.value)) {
    if (!['error', 'failed'].includes(event.level) && !/fail|error/i.test(event.type || '')) continue;
    issues.push({ severity: 0, order: 1000, title: event.type || '近期异常', reason: event.message || '事件失败',
      target: event.sessionId ? '#sessions/' + encodeURIComponent(event.sessionId) : '#activity', action: event.sessionId ? '查看 Session' : '查看活动',
      identifier: event.sessionId || event.type || '近期活动' });
  }
  issues.sort((left, right) => left.severity - right.severity || left.order - right.order);
  if (issues.length === 0) {
    if (statusState.error && eventsState.error) return feedback.showError(statusState.error);
    return feedback.showEmpty('当前没有需处理问题');
  }
  const list = element('div', { document: documentRef, className: 'issue-list' });
  for (const issue of issues) {
    const button = element('button', { document: documentRef, className: 'button', text: issue.action,
      attributes: { type: 'button', 'aria-label': issue.action + '：' + issue.identifier } });
    listen(button, 'click', () => context.navigate(issue.target));
    list.append(element('article', { document: documentRef, className: 'issue-card' },
      element('h3', { document: documentRef, text: issue.title }),
      element('p', { document: documentRef, text: issue.reason }), button));
  }
  feedback.showContent(list);
}

function renderSummary(documentRef, feedback, sessionsState, routesState) {
  if (sessionsState.error && routesState.error) return feedback.showError(sessionsState.error);
  const sessions = normalizeList(sessionsState.value);
  const routes = normalizeList(routesState.value);
  const summary = element('dl', { document: documentRef, className: 'summary-grid' });
  for (const [label, value] of [
    ['Session', sessionsState.error ? '不可用' : sessions.length],
    ['Route', routesState.error ? '不可用' : routes.length],
    ['活跃 Session', sessions.filter(isActiveSession).length],
    ['悬空 Route', routes.filter(route => route.dangling).length],
  ]) summary.append(element('dt', { document: documentRef, text: label }), element('dd', { document: documentRef, text: value }));
  feedback.showContent(summary);
}

function renderActivity(documentRef, context, feedback, state) {
  if (state.error) return feedback.showError(state.error);
  const events = normalizeEvents(state.value);
  if (events.length === 0) return feedback.showEmpty('暂无近期活动');
  feedback.showContent(createDataTable({
    document: documentRef,
    caption: '近期活动',
    columns: [
      { key: 'createdAt', label: '时间', render: row => formatDateTime(row.createdAt) },
      { key: 'level', label: '级别' }, { key: 'type', label: '类型' }, { key: 'message', label: '内容' },
      { key: 'action', label: '对象', render: row => createSessionAction(documentRef, context, row.sessionId) },
    ],
    rows: events,
  }));
}

function renderTrend(documentRef, feedback, state) {
  if (state.error) return feedback.showError(state.error);
  const metrics = state.value || {};
  const buckets = Array.isArray(metrics.buckets) ? metrics.buckets.slice(-60) : [];
  const totals = buckets.reduce((sum, bucket) => ({
    messages: sum.messages + Number(bucket.messages || 0),
    prompts: sum.prompts + Number(bucket.prompts || 0),
    errors: sum.errors + Number(bucket.errors || 0),
  }), { messages: 0, prompts: 0, errors: 0 });
  const content = element('div', { document: documentRef, className: 'trend-summary' });
  content.append(element('p', { document: documentRef, className: 'muted', text: '每分钟一个桶，包含当前分钟。' }));
  for (const [label, value] of [['消息', totals.messages], ['Prompt', totals.prompts], ['错误', totals.errors]]) {
    content.append(element('p', { document: documentRef },
      element('strong', { document: documentRef, text: label }),
      element('span', { document: documentRef, text: value })));
  }
  feedback.showContent(content);
}

function renderActiveSessions(documentRef, context, feedback, state) {
  if (state.error) return feedback.showError(state.error);
  const sessions = normalizeList(state.value).filter(isActiveSession)
    .sort((left, right) => Number(right.lastActiveAt || 0) - Number(left.lastActiveAt || 0));
  if (sessions.length === 0) return feedback.showEmpty('暂无活跃 Session');
  feedback.showContent(createDataTable({
    document: documentRef,
    caption: '活跃 Session',
    columns: [
      { key: 'id', label: 'Session', render: row => shortId(row.id) }, { key: 'title', label: '标题' },
      { key: 'status', label: '状态' }, { key: 'transport', label: '来源' }, { key: 'runtimeId', label: 'Runtime' },
      { key: 'lastActiveAt', label: '最近活动', render: row => formatDateTime(row.lastActiveAt) },
      { key: 'action', label: '操作', render: row => createSessionAction(documentRef, context, row.id) },
    ],
    rows: sessions,
  }));
}

function createSessionAction(documentRef, context, sessionId) {
  if (!sessionId) return '无';
  const button = element('button', { document: documentRef, className: 'button', text: '查看 Session',
    attributes: { type: 'button', 'aria-label': '查看 Session ' + sessionId } });
  listen(button, 'click', () => context.navigate('#sessions/' + encodeURIComponent(sessionId)));
  return button;
}

function unwrap(response) {
  return response && response.ok === true && Object.prototype.hasOwnProperty.call(response, 'data') ? response.data : response;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.list) ? value.list : [];
}

function normalizeEvents(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.events)) return value.events;
  return normalizeList(value);
}

function isActiveSession(session) {
  return ['active', 'running', 'busy', 'waiting'].includes(String(session?.status || '').toLowerCase());
}
