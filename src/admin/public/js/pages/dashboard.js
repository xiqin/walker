import { element, listen } from '../dom.js';
import { compactPath, formatDateTime, shortId } from '../format.js';
import { createStatusCard } from '../components/status-card.js';
import { createDataTable } from '../components/data-table.js';

const STATUS_LABELS = {
  walker: 'Walker', feishu: '飞书', opencode: 'OpenCode', tuiBridge: 'TUI Bridge',
  runtimes: 'Runtime', watchers: 'Watcher', health: 'Health', admin: 'Admin',
};
const SEVERITY = { failed: 0, error: 0, warning: 1, unknown: 2, healthy: 3, pass: 3, warn: 1, fail: 0 };

function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知';
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${mins} 分`;
  if (mins > 0) return `${mins} 分`;
  return `${total} 秒`;
}

/** 挂载异常优先的运行总览。 */
export async function mount(context) {
  const documentRef = context.document || document;
  const page = element('div', { document: documentRef, className: 'page dashboard-page' });
  page.append(element('h1', { document: documentRef, className: 'visually-hidden', text: '运行控制台' }));

  const statsGrid = element('div', { document: documentRef, className: 'grid grid-4', attributes: { 'aria-label': '服务状态' } });
  const issuesCard = element('div', { document: documentRef, className: 'card' });
  const summaryCard = element('div', { document: documentRef, className: 'card' });
  const activityCard = element('div', { document: documentRef, className: 'card' });
  const trendCard = element('div', { document: documentRef, className: 'card' });
  const activeCard = element('div', { document: documentRef, className: 'card card-flat' });
  page.append(statsGrid,
    element('div', { document: documentRef, className: 'grid grid-2-1' }, issuesCard, summaryCard),
    element('div', { document: documentRef, className: 'grid grid-2' }, activityCard, trendCard),
    activeCard);
  context.root.replaceChildren(page);

  const cleanups = [];
  cleanups.push(listen(context.root, 'walker:refresh', () => load()));
  let active = true;

  async function load() {
    const requests = {
      status: context.api.get('/api/admin/status', { signal: context.signal }),
      overview: context.api.get('/api/admin/overview', { signal: context.signal }),
      sessions: context.api.get('/api/admin/sessions', { signal: context.signal }),
      routes: context.api.get('/api/admin/routes', { signal: context.signal }),
      events: context.api.get('/api/admin/events?limit=8', { signal: context.signal }),
      metrics: context.api.get('/api/admin/metrics', { signal: context.signal }),
    };
    const entries = await Promise.all(Object.entries(requests).map(async ([name, request]) => {
      try { return [name, { value: unwrap(await request) }]; }
      catch (error) { return [name, { error }]; }
    }));
    if (!active || (context.isCurrent && !context.isCurrent())) return;
    const result = Object.fromEntries(entries);
    context.commit(() => {
      renderStats(documentRef, statsGrid, result.status, result.overview);
      renderIssues(documentRef, context, issuesCard, result.status, result.events);
      renderSummary(documentRef, summaryCard, result.sessions, result.routes, result.metrics);
      renderActivity(documentRef, context, activityCard, result.events);
      renderTrend(documentRef, trendCard, result.metrics);
      renderActive(documentRef, context, activeCard, result.sessions);
    });
  }

  await load();
  return () => { active = false; for (const dispose of cleanups) dispose(); };
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

function badge(documentRef, status) {
  const map = { healthy: 'green', pass: 'green', active: 'green', running: 'amber', warning: 'amber', warn: 'amber', failed: 'red', fail: 'red', error: 'red', idle: 'blue', detached: 'red', unknown: 'gray' };
  return element('span', { document: documentRef, className: 'badge badge-' + (map[String(status || '').toLowerCase()] || 'gray'), text: String(status || 'unknown') });
}

function renderStats(documentRef, grid, statusState, overviewState) {
  grid.replaceChildren();
  if (statusState.error) {
    grid.append(element('p', { document: documentRef, className: 'feedback__error', text: statusState.error.message || 'status backend offline' }));
    return;
  }
  const status = statusState.value || {};
  const overview = overviewState.value || {};
  const process = overview.process || {};
  const agents = Array.isArray(overview.agents) ? overview.agents : [];
  const opencode = agents.find(item => item && item.name === 'opencode') || {};
  const pid = process.pid || '未知';
  const byStatus = (overview.sessions && overview.sessions.byStatus) || {};
  const activeCount = ['running', 'active', 'busy', 'waiting'].reduce((sum, key) => sum + Number(byStatus[key] || 0), 0);
  const routeTotal = (overview.routes && overview.routes.total) || 0;
  const routeDangling = (overview.routes && overview.routes.dangling) || 0;
  grid.append(
    createStatusCard({
      document: documentRef, card: true, title: 'Walker 进程', status: status.walker?.status || 'unknown', icon: 'W', iconColor: '#111827',
      details: [['PID', pid], ['运行时长', formatUptime(process.uptime)]], foot: 'walker status',
    }),
    createStatusCard({
      document: documentRef, card: true, title: '飞书长连接', status: status.feishu?.status || 'unknown', icon: '◆', iconColor: '#2563eb',
      details: [['事件订阅', 'im.message.receive_v1'], ['来源', overview.feishu?.source || '—']], foot: '长连接接收',
    }),
    createStatusCard({
      document: documentRef, card: true, title: 'OpenCode Server', status: status.opencode?.status || 'unknown', icon: '</>', iconColor: '#7c3aed',
      details: [['端点', opencode.config?.serverUrl || 'localhost:4096'], ['自动启动', opencode.config?.autostart === false ? '关闭' : '已启用']], foot: 'health poll',
    }),
    createStatusCard({
      document: documentRef, card: true, title: '会话 / 路由', status: summaryStatus(status), icon: '◐', iconColor: '#0891b2',
      details: [['活跃会话', activeCount], ['Route', routeTotal]], foot: '悬空 ' + routeDangling,
    }),
  );
}

function summaryStatus(status) {
  const items = Object.values(status || {});
  if (items.some(item => item?.status === 'failed')) return 'failed';
  if (items.some(item => item?.status === 'warning')) return 'warning';
  return 'healthy';
}

function isActiveSession(session) {
  return ['active', 'running', 'busy', 'waiting'].includes(String(session?.status || '').toLowerCase());
}

function renderIssues(documentRef, context, card, statusState, eventsState) {
  card.replaceChildren(element('div', { document: documentRef, className: 'section-title', text: '需处理问题 ' }));
  const titleSpan = element('span', { document: documentRef });
  card.children[0].append(titleSpan);
  const issues = [];
  if (statusState.value) {
    let order = 0;
    for (const [name, item] of Object.entries(statusState.value)) {
      if (item.status === 'healthy') continue;
      const label = STATUS_LABELS[name] || name;
      issues.push({
        severity: SEVERITY[item.status] ?? 2, order: order++,
        title: label, identifier: label, reason: item.reason || '状态不可用',
        target: item.action?.target || '#connections', action: '处理问题',
      });
    }
  }
  for (const event of normalizeEvents(eventsState.value)) {
    if (!['error', 'failed'].includes(event.level) && !/fail|error/i.test(event.type || '')) continue;
    issues.push({ severity: 0, order: 1000, title: event.type || '近期异常', identifier: event.sessionId || event.type || '近期活动', reason: event.message || '事件失败',
      target: event.sessionId ? '#sessions/' + encodeURIComponent(event.sessionId) : '#logs', action: event.sessionId ? '查看 Session' : '查看活动' });
  }
  issues.sort((left, right) => left.severity - right.severity || left.order - right.order);
  titleSpan.textContent = issues.length;
  if (issues.length === 0) {
    card.append(element('p', { document: documentRef, className: 'muted', text: '当前没有需处理问题' }));
    return;
  }
  for (const issue of issues) {
    const button = element('button', { document: documentRef, className: 'btn btn-sm', text: issue.action, attributes: { type: 'button', 'aria-label': issue.action + '：' + issue.identifier } });
    listen(button, 'click', () => context.navigate(issue.target));
    card.append(element('div', { document: documentRef, className: 'issue-row' },
      element('div', { document: documentRef, className: 'issue-left' },
        element('span', { document: documentRef, text: '⚠', attributes: { style: 'color:var(--' + (issue.severity === 0 ? 'red' : 'amber') + ';font-size:16px;' } }),
        element('div', { document: documentRef },
          element('div', { document: documentRef, style: 'font-weight:600;', text: issue.title }),
          element('div', { document: documentRef, style: 'font-size:12px;color:var(--text-secondary);margin-top:3px;', text: issue.reason }))),
      button));
  }
  const link = element('span', { document: documentRef, className: 'link', text: '查看全部问题 ›' });
  listen(link, 'click', () => context.navigate('#diagnostics'));
  card.append(element('div', { document: documentRef, style: 'margin-top:6px;' }, link));
}

function renderSummary(documentRef, card, sessionsState, routesState) {
  card.replaceChildren(element('div', { document: documentRef, className: 'section-title', text: '会话概况' }));
  if (sessionsState.error && routesState.error) {
    card.append(element('p', { document: documentRef, className: 'feedback__error', text: sessionsState.error.message || '加载失败' }));
    return;
  }
  const sessions = normalizeList(sessionsState.value);
  const routes = normalizeList(routesState.value);
  const running = sessions.filter(s => s.currentTurn).length;
  const detached = sessions.filter(s => s.health?.status === 'failed' || s.status === 'detached').length;
  const dangling = routes.filter(r => r.dangling).length;
  const summary = element('dl', { document: documentRef, className: 'summary-grid', attributes: { style: 'display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin-bottom:14px;' } });
  for (const [label, value] of [
    ['Session', sessionsState.error ? '不可用' : sessions.length],
    ['Route', routesState.error ? '不可用' : routes.length],
    ['活跃 Session', sessionsState.error ? '不可用' : sessions.filter(isActiveSession).length],
    ['悬空 Route', dangling],
    ['running turn', running], ['detached', detached],
  ]) {
    summary.append(element('dt', { document: documentRef, text: label }), element('dd', { document: documentRef, text: String(value) }));
  }
  card.append(summary);
  card.append(element('div', { document: documentRef, style: 'font-size:11.5px;color:var(--text-secondary);margin-bottom:5px;', text: 'Session 状态分布' }));
  const dist = statusDistribution(sessions);
  const bar = element('div', { document: documentRef, className: 'progress-bar', attributes: { style: 'margin-bottom:6px;' } });
  for (const [color, pct] of dist) bar.append(element('div', { document: documentRef, className: 'progress-seg', attributes: { style: `width:${pct}%;background:var(--${color});` } }));
  card.append(bar);
  const legend = element('div', { document: documentRef, style: 'display:flex;gap:14px;font-size:11px;color:var(--text-secondary);margin-bottom:12px;' });
  for (const [color, label] of [['accent', 'idle'], ['amber', 'running'], ['red', 'detached']]) {
    legend.append(element('span', { document: documentRef },
      element('span', { document: documentRef, className: 'dot', attributes: { style: `background:var(--${color});` } }),
      element('span', { document: documentRef, text: ' ' + label })));
  }
  card.append(legend);
}

function statusDistribution(sessions) {
  const total = sessions.length || 1;
  const idle = sessions.filter(s => !isActiveSession(s) && s.health?.status !== 'failed').length;
  const running = sessions.filter(isActiveSession).length;
  const detached = sessions.filter(s => s.health?.status === 'failed' || s.status === 'detached').length;
  return [['accent', Math.round(idle / total * 100)], ['amber', Math.round(running / total * 100)], ['red', Math.round(detached / total * 100)]];
}

function renderActivity(documentRef, context, card, state) {
  card.replaceChildren(element('div', { document: documentRef, className: 'section-title', text: '近期活动' }));
  if (state.error) { card.append(element('p', { document: documentRef, className: 'feedback__error', text: state.error.message })); return; }
  const events = normalizeEvents(state.value);
  if (events.length === 0) { card.append(element('p', { document: documentRef, className: 'muted', text: '暂无近期活动' })); return; }
  const list = element('div', { document: documentRef, attributes: { style: 'display:flex;flex-direction:column;gap:12px;' } });
  for (const event of events) {
    list.append(element('div', { document: documentRef, attributes: { style: 'display:flex;gap:10px;font-size:12.5px;' } },
      element('span', { document: documentRef, attributes: { style: 'color:var(--text-muted);width:90px;flex-shrink:0;' }, text: formatDateTime(event.createdAt || event.timestamp).slice(-8) || '—' }),
      element('span', { document: documentRef, className: 'dot', attributes: { style: 'margin-top:5px;background:var(--accent);' } }),
      element('span', { document: documentRef, text: [event.type, event.message].filter(Boolean).join('　') || '—' })));
  }
  card.append(list);
  const link = element('span', { document: documentRef, className: 'link', text: '查看全部活动 ›' });
  listen(link, 'click', () => context.navigate('#logs'));
  card.append(element('div', { document: documentRef, attributes: { style: 'margin-top:12px;' } }, link));
}

function renderTrend(documentRef, card, state) {
  card.replaceChildren(element('div', { document: documentRef, className: 'section-title' },
    element('span', { document: documentRef, text: 'Turn 与投递趋势 ' }),
    element('span', { document: documentRef, attributes: { style: 'font-weight:400;color:var(--text-secondary);font-size:12px;' }, text: '（最近 60 分钟）' })));
  if (state.error) { card.append(element('p', { document: documentRef, className: 'feedback__error', text: state.error.message })); return; }
  const metrics = state.value || {};
  const buckets = Array.isArray(metrics.buckets) ? metrics.buckets.slice(-60) : [];
  const totals = buckets.reduce((sum, bucket) => ({
    messages: sum.messages + Number(bucket.messages || 0),
    prompts: sum.prompts + Number(bucket.prompts || 0),
    errors: sum.errors + Number(bucket.errors || 0),
  }), { messages: 0, prompts: 0, errors: 0 });
  card.append(buildTrendSvg(documentRef, buckets));
  card.append(element('div', { document: documentRef, attributes: { style: 'display:flex;gap:16px;font-size:11.5px;color:var(--text-secondary);margin-top:4px;' } },
    legendDot(documentRef, 'green', '消息'), legendDot(documentRef, 'accent', 'Prompt'), legendDot(documentRef, 'red', '错误')));
  card.append(element('p', { document: documentRef, className: 'muted', attributes: { style: 'margin-top:8px;' }, text: '每分钟一个桶，包含当前分钟。' }));
  card.append(element('p', { document: documentRef },
    element('strong', { document: documentRef, text: '消息 ' }), element('span', { document: documentRef, text: String(totals.messages) + '　' }),
    element('strong', { document: documentRef, text: 'Prompt ' }), element('span', { document: documentRef, text: String(totals.prompts) + '　' }),
    element('strong', { document: documentRef, text: '错误 ' }), element('span', { document: documentRef, text: String(totals.errors) })));
}

function legendDot(documentRef, color, label) {
  return element('span', { document: documentRef },
    element('span', { document: documentRef, className: 'dot', attributes: { style: `background:var(--${color});` } }),
    element('span', { document: documentRef, text: ' ' + label }));
}

function buildTrendSvg(documentRef, buckets) {
  const svg = element('svg', { document: documentRef, attributes: { viewBox: '0 0 480 160', style: 'width:100%;height:150px;', 'aria-label': 'Turn 与投递趋势' } });
  const series = [
    { key: 'messages', color: 'var(--green)' },
    { key: 'prompts', color: 'var(--accent)' },
    { key: 'errors', color: 'var(--red)' },
  ];
  const width = 480, height = 160, pad = 8;
  const n = Math.max(buckets.length, 1);
  for (const { key, color } of series) {
    const max = Math.max(1, ...buckets.map(b => Number(b[key] || 0)));
    const pts = buckets.map((b, i) => {
      const x = buckets.length ? (i / (n - 1)) * (width - pad * 2) + pad : pad;
      const v = Number(b[key] || 0);
      const y = height - pad - (v / max) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ') || `${pad},${height - pad}`;
    const poly = element('polyline', { document: documentRef, attributes: { points: pts, fill: 'none', stroke: color, 'stroke-width': '2' } });
    svg.append(poly);
  }
  return svg;
}

function renderActive(documentRef, context, card, state) {
  card.replaceChildren();
  const toolbar = element('div', { document: documentRef, className: 'toolbar' },
    element('div', { document: documentRef, className: 'section-title', attributes: { style: 'margin:0;flex:1;' }, text: '活跃会话（Walker session）' }));
  const search = element('input', { document: documentRef, className: 'search-input', attributes: { type: 'search', placeholder: '搜索 session / routeKey / cwd', 'aria-label': '搜索活跃会话' } });
  toolbar.append(search);
  const allLink = element('span', { document: documentRef, className: 'link', text: '查看全部 ›' });
  listen(allLink, 'click', () => context.navigate('#sessions'));
  toolbar.append(allLink);
  card.append(toolbar);
  const tableWrap = element('div', { document: documentRef, className: 'wide-table' });
  card.append(tableWrap);
  if (state.error) { tableWrap.append(element('p', { document: documentRef, className: 'feedback__error', text: state.error.message })); return; }
  const sessions = normalizeList(state.value).filter(isActiveSession).sort((a, b) => Number(b.lastActiveAt || 0) - Number(a.lastActiveAt || 0));
  if (sessions.length === 0) { tableWrap.append(element('p', { document: documentRef, className: 'muted', attributes: { style: 'padding:16px;' }, text: '暂无活跃 Session' })); return; }
  const table = createDataTable({
    document: documentRef,
    caption: '活跃会话',
    columns: [
      { key: 'id', label: 'Session', render: row => shortId(row.id) },
      { key: 'agent', label: 'Agent', render: row => row.agent || '—' },
      { key: 'status', label: '状态', render: row => badge(documentRef, row.status) },
      { key: 'route', label: 'Route（焦点）', render: row => {
        const routeKeys = row.routeKeys || [];
        const isFocus = row.focusRouteKeys && row.focusRouteKeys.length > 0;
        const text = routeKeys.join(' ') || '—';
        const cell = element('span', { document: documentRef, text });
        if (isFocus) cell.append(element('span', { document: documentRef, className: 'badge badge-blue', text: '焦点', attributes: { style: 'margin-left:4px;' } }));
        return cell;
      }},
      { key: 'runtime', label: 'Runtime', render: row => row.runtimeId || row.runtime || '—' },
      { key: 'opencode', label: 'OpenCode', render: row => shortId(row.opencodeSessionId || '—') },
      { key: 'cwd', label: 'cwd', render: row => compactPath(row.cwd) },
      { key: 'lastActiveAt', label: '最近事件', render: row => formatDateTime(row.lastActiveAt) },
    ],
    rows: sessions,
  });
  listen(search, 'input', () => {
    if (typeof table.querySelectorAll !== 'function') return;
    const q = search.value.toLowerCase();
    table.querySelectorAll('tbody tr').forEach(tr => { tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; });
  });
  tableWrap.append(table);
}


