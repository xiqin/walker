import { combineCleanups, element, listen, setBusy } from '../dom.js';
import { compactPath, formatDateTime, formatStatus } from '../format.js';
import { createDrawer } from '../components/drawer.js';
import { createTabs } from '../components/tabs.js';
import { createConfirm } from '../components/feedback.js';

const PAGE_SIZE = 20;

const DEFAULT_FILTERS = {
  query: '', agent: '', status: '', runtime: '', tab: 'sessions', scrollTop: 0, page: 1,
};

/** 按关键词、Agent、状态、Runtime 执行本地 AND 过滤。 */
export function filterSessions(sessions, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  const agent = String(filters.agent || '');
  const status = String(filters.status || '');
  const runtime = String(filters.runtime || '');
  return (sessions || []).filter(session => {
    const routeKeys = Array.isArray(session.routeKeys) ? session.routeKeys : [];
    const searchable = [session.id, session.title, session.cwd, session.opencodeSessionId, session.runtimeId, ...routeKeys]
      .filter(value => value != null).join(' ').toLowerCase();
    return (!query || searchable.includes(query))
      && (!agent || (session.agent || 'opencode') === agent)
      && (!status || session.status === status)
      && (!runtime || (session.runtime || session.runtimeId || 'unknown') === runtime);
  });
}

/** 挂载 Session/Route 双 Tab 工作区。 */
export async function mount(context) {
  const documentRef = context.document || document;
  const api = context.api;
  const pageCleanups = [];
  const sessionControlCleanups = [];
  const sessionRowCleanups = [];
  const detailCleanups = [];
  let active = true;
  let sessions = [];
  let routes = [];
  let detailId = context.route?.params?.id || null;
  let filters = {
    ...DEFAULT_FILTERS,
    ...(context.store?.getState?.().filters?.sessions || {}),
    ...(context.route?.query?.tab ? { tab: context.route.query.tab } : {}),
  };
  const initialScrollTop = Number(filters.scrollTop) || 0;

  const page = element('section', { document: documentRef, className: 'sessions-workspace', attributes: { 'aria-labelledby': 'sessions-title' } });
  page.append(element('h1', { document: documentRef, className: 'visually-hidden', text: '会话与路由', attributes: { id: 'sessions-title' } }));
  const message = element('p', { document: documentRef, className: 'operation-feedback', attributes: { role: 'status', 'aria-live': 'polite' } });
  const sessionPanel = element('section', { document: documentRef, className: 'subpage active', attributes: { id: 'sub-sess-list' } });
  const routePanel = element('section', { document: documentRef, className: 'subpage', attributes: { id: 'sub-sess-routes' } });
  const drawer = createDrawer({ document: documentRef, id: 'session-detail', title: 'Session 详情' });
  const confirm = context.confirm || createConfirm({ document: documentRef, title: '确认危险操作' });
  const tabs = createTabs({
    document: documentRef,
    label: 'Session 与 Route',
    selected: filters.tab === 'routes' ? 'routes' : 'sessions',
    tabs: [
      { id: 'sessions', label: '会话（Walker Session）', panel: sessionPanel },
      { id: 'routes', label: '路由（routeKey）', panel: routePanel },
    ],
    onChange(id) { filters.tab = id; persistFilters(); },
  });
  page.append(tabs.element, message, sessionPanel, routePanel, drawer.element);
  if (!context.confirm) page.append(confirm.element);
  context.root.replaceChildren(page);

  function responseData(response) { return response && Object.hasOwn(response, 'data') ? response.data : response; }
  function commit(callback) {
    if (!active || context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return;
    if (context.commit) context.commit(callback); else callback();
  }
  function persistFilters() { filters.scrollTop = context.root.scrollTop || 0; context.store?.setPageFilters?.('sessions', filters); }
  function clearCleanups(cleanups) { while (cleanups.length > 0) cleanups.pop()(); }
  function on(target, type, handler, cleanups = pageCleanups) { const cleanup = listen(target, type, handler); cleanups.push(cleanup); return cleanup; }
  function showMessage(value, tone = 'neutral') {
    commit(() => { message.textContent = value ? String(value) : ''; message.dataset.tone = tone; });
  }

  async function loadSessions() {
    const payload = responseData(await api.get('/api/admin/sessions', { signal: context.signal }));
    sessions = Array.isArray(payload?.list) ? payload.list : [];
    commit(renderSessions);
  }
  async function loadRoutes() {
    const payload = responseData(await api.get('/api/admin/routes', { signal: context.signal }));
    routes = Array.isArray(payload?.list) ? payload.list : [];
    commit(renderRoutes);
  }

  function statusBadge(status) {
    const fmt = formatStatus(status);
    const map = { healthy: 'green', pass: 'green', warning: 'amber', warn: 'amber', running: 'amber', failed: 'red', fail: 'red', error: 'red', idle: 'blue', detached: 'red', unknown: 'gray' };
    return element('span', { document: documentRef, className: 'badge badge-' + (map[String(status || '').toLowerCase()] || 'gray'), text: fmt.label });
  }

  function renderSessions() {
    clearCleanups(sessionRowCleanups);
    clearCleanups(sessionControlCleanups);
    sessionPanel.replaceChildren(
      element('div', { document: documentRef, className: 'note-box', text: '对应 /status、/list、/cancel、/stop、/delete、/clear 命令的可视化管理；数据来自 .walker/sessions.json。' }),
    );
    const controls = element('form', { document: documentRef, className: 'toolbar', attributes: { 'aria-label': 'Session 过滤' } });
    const query = element('input', { document: documentRef, className: 'search-input', attributes: { name: 'session-query', type: 'search', 'aria-label': '搜索 Session', placeholder: '搜索 session / routeKey / cwd' } });
    query.value = filters.query;

    const agents = [...new Set(sessions.map(item => item.agent || 'opencode'))];
    const statuses = [...new Set(sessions.map(item => item.status).filter(Boolean))];
    const runtimes = [...new Set(sessions.map(item => item.runtime || item.runtimeId || 'unknown'))];

    const agent = element('select', { document: documentRef, className: 'select', attributes: { name: 'session-agent', 'aria-label': 'Agent' } });
    agent.append(element('option', { document: documentRef, text: 'Agent：全部', attributes: { value: '' } }));
    for (const value of agents) agent.append(element('option', { document: documentRef, text: value, attributes: { value } }));
    agent.value = filters.agent;

    const status = element('select', { document: documentRef, className: 'select', attributes: { name: 'session-status', 'aria-label': '状态' } });
    status.append(element('option', { document: documentRef, text: '状态：全部', attributes: { value: '' } }));
    for (const value of statuses) status.append(element('option', { document: documentRef, text: value, attributes: { value } }));
    status.value = filters.status;

    const runtime = element('select', { document: documentRef, className: 'select', attributes: { name: 'session-runtime', 'aria-label': 'Runtime' } });
    runtime.append(element('option', { document: documentRef, text: 'Runtime：全部', attributes: { value: '' } }));
    for (const value of runtimes) runtime.append(element('option', { document: documentRef, text: value, attributes: { value } }));
    runtime.value = filters.runtime;

    controls.append(query, agent, status, runtime);
    const card = element('div', { document: documentRef, className: 'card card-flat' });
    const wrap = element('div', { document: documentRef, className: 'wide-table' });
    const table = element('table', { document: documentRef });
    const headRow = element('tr', { document: documentRef });
    for (const label of ['Session ID', 'Agent', '状态', 'Route', '焦点', 'Runtime', 'OpenCode Session', 'cwd', 'Turn 运行时长', '最近事件', '操作']) {
      headRow.append(element('th', { document: documentRef, text: label }));
    }
    table.append(element('thead', { document: documentRef }, headRow));
    const body = element('tbody', { document: documentRef, attributes: { 'aria-live': 'polite' } });
    table.append(body);
    wrap.append(table);
    card.append(wrap);

    const pager = element('div', { document: documentRef, className: 'pagination' });
    const pagerInfo = element('span', { document: documentRef, className: 'pagination-info' });
    const prevBtn = element('button', { document: documentRef, className: 'btn btn-sm', text: '上一页', attributes: { type: 'button' } });
    const nextBtn = element('button', { document: documentRef, className: 'btn btn-sm', text: '下一页', attributes: { type: 'button' } });
    pager.append(prevBtn, pagerInfo, nextBtn);

    sessionPanel.append(controls, card, pager);

    function resetPage() { filters.page = 1; }

    function refreshLocalList() {
      clearCleanups(sessionRowCleanups);
      const visible = filterSessions(sessions, filters);
      const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
      if (filters.page > totalPages) filters.page = totalPages;
      const start = (filters.page - 1) * PAGE_SIZE;
      const pageItems = visible.slice(start, start + PAGE_SIZE);

      body.replaceChildren();
      if (visible.length === 0) {
        body.append(element('tr', { document: documentRef }, element('td', { document: documentRef, attributes: { colspan: '11' }, text: '没有匹配的 Session。' })));
      } else {
        for (const session of pageItems) body.append(renderSessionRow(session));
      }

      pagerInfo.textContent = '第 ' + filters.page + ' / ' + totalPages + ' 页（共 ' + visible.length + ' 条）';
      prevBtn.disabled = filters.page <= 1;
      nextBtn.disabled = filters.page >= totalPages;
      pager.hidden = visible.length === 0;
    }

    function onPageChange(newPage) { filters.page = newPage; persistFilters(); refreshLocalList(); }
    on(prevBtn, 'click', () => { if (filters.page > 1) onPageChange(filters.page - 1); }, sessionControlCleanups);
    on(nextBtn, 'click', () => { const vis = filterSessions(sessions, filters); if (filters.page < Math.ceil(vis.length / PAGE_SIZE)) onPageChange(filters.page + 1); }, sessionControlCleanups);

    on(query, 'input', () => { filters.query = query.value; resetPage(); persistFilters(); refreshLocalList(); }, sessionControlCleanups);
    on(agent, 'change', () => { filters.agent = agent.value; resetPage(); persistFilters(); refreshLocalList(); }, sessionControlCleanups);
    on(status, 'change', () => { filters.status = status.value; resetPage(); persistFilters(); refreshLocalList(); }, sessionControlCleanups);
    on(runtime, 'change', () => { filters.runtime = runtime.value; resetPage(); persistFilters(); refreshLocalList(); }, sessionControlCleanups);
    refreshLocalList();
  }

  function renderSessionRow(session) {
    const row = element('tr', { document: documentRef, attributes: { 'data-search': `${session.id} ${(session.routeKeys || []).join(' ')} ${session.cwd || ''} ${session.agent || ''}` } });
    const isFocus = session.focusRouteKeys && session.focusRouteKeys.length > 0;
    const routeText = (session.routeKeys || []).join(' ') || '—';

    const statusLink = element('span', { document: documentRef, className: 'link', text: '/status', attributes: { role: 'button', tabindex: '0' } });
    on(statusLink, 'click', () => openDetail(session.id, statusLink, true), sessionRowCleanups);
    const cancelLink = element('span', { document: documentRef, className: 'link', text: '/cancel', attributes: { role: 'button', tabindex: '0' } });
    on(cancelLink, 'click', () => runSessionAction('stop', session.id, cancelLink), sessionRowCleanups);
    const deleteLink = element('span', { document: documentRef, className: 'link link-red', text: '/delete', attributes: { role: 'button', tabindex: '0' } });
    on(deleteLink, 'click', () => runSessionAction('delete', session.id, deleteLink), sessionRowCleanups);

    const opsCell = element('td', { document: documentRef });
    opsCell.append(statusLink, documentRef.createTextNode('  '), cancelLink, documentRef.createTextNode('  '), deleteLink);

    row.append(
      element('td', { document: documentRef, className: 'mono', text: session.id }),
      element('td', { document: documentRef, text: session.agent || 'opencode' }),
      element('td', { document: documentRef }, statusBadge(session.status)),
      element('td', { document: documentRef, text: routeText }),
      element('td', { document: documentRef, text: isFocus ? '✓' : '—' }),
      element('td', { document: documentRef, text: session.runtime || session.runtimeId || 'unknown' }),
      element('td', { document: documentRef, className: 'mono', text: session.opencodeSessionId || '—' }),
      element('td', { document: documentRef, className: 'mono', text: compactPath(session.cwd, 48) }),
      element('td', { document: documentRef, text: turnDuration(session) }),
      element('td', { document: documentRef, className: 'mono', text: formatDateTime(session.lastActiveAt) }),
      opsCell,
    );
    return row;
  }

  function turnDuration(session) {
    const turn = session.currentTurn;
    if (!turn) return '—';
    if (turn.durationMs != null) return Math.ceil(Number(turn.durationMs) / 1000) + ' 秒';
    if (turn.startedAt) {
      const ms = Date.now() - Number(turn.startedAt);
      if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms / 1000) + ' 秒';
    }
    return turn.state || turn.status || '—';
  }

  async function openDetail(sessionId, trigger, navigate) {
    detailId = sessionId;
    persistFilters();
    if (navigate) await context.navigate?.('#sessions/' + encodeURIComponent(sessionId) + '?tab=' + filters.tab);
    try {
      const detail = responseData(await api.get('/api/admin/sessions/' + encodeURIComponent(sessionId), { signal: context.signal }));
      commit(() => drawer.open(renderSessionDetail(detail), trigger));
    } catch (error) {
      showMessage(error.message || 'Session 详情加载失败', 'danger');
    }
  }

  function renderSessionDetail(session) {
    clearCleanups(detailCleanups);
    const content = element('div', { document: documentRef, className: 'session-detail' });
    const timeline = element('ol', { document: documentRef, className: 'timeline' });
    for (const event of session.timeline || []) {
      timeline.append(element('li', { document: documentRef, text: [event.type || 'event', event.message || '', formatDateTime(event.timestamp || event.createdAt)].join(' · ') }));
    }
    if ((session.timeline || []).length === 0) timeline.append(element('li', { document: documentRef, text: '暂无时间线' }));
    const stop = element('button', { document: documentRef, className: 'btn btn-danger', text: '停止 Session', attributes: { type: 'button' } });
    const remove = element('button', { document: documentRef, className: 'btn btn-danger', text: '删除 Session', attributes: { type: 'button' } });
    content.append(
      element('h3', { document: documentRef, text: session.title || session.id }),
      detailList([
        ['Session ID', session.id], ['状态', session.status || 'unknown'], ['Route', (session.routeKeys || []).join(', ') || 'unknown'],
        ['焦点 Route', (session.focusRouteKeys || []).join(', ') || 'unknown'], ['Runtime ID', session.runtimeId || 'unknown'],
        ['OpenCode Session', session.opencodeSessionId || 'unknown'], ['Transport', session.transport || 'unknown'],
        ['Watch', session.watch ? (session.watch.active ? 'active · ' + (session.watch.mode || 'unknown') : 'inactive') : 'unknown'],
        ['Health', session.health?.status || 'unknown'], ['Health 原因', session.health?.reason || 'unknown'],
        ['最近心跳', formatDateTime(session.lastHeartbeatAt)], ['当前 Turn', session.currentTurn?.state || session.currentTurn?.status || 'unknown'],
        ['CWD', session.cwd || 'unknown'], ['最近活动', formatDateTime(session.lastActiveAt)],
      ]),
      element('h3', { document: documentRef, text: '时间线' }), timeline,
      element('section', { document: documentRef, className: 'danger-zone', attributes: { 'aria-label': 'Session 危险操作' } },
        element('h3', { document: documentRef, text: '危险操作' }), stop, remove),
    );
    on(stop, 'click', () => runSessionAction('stop', session.id, stop), detailCleanups);
    on(remove, 'click', () => runSessionAction('delete', session.id, remove), detailCleanups);
    return content;
  }

  function detailList(entries) {
    const list = element('dl', { document: documentRef, className: 'detail-list' });
    for (const [label, value] of entries) {
      list.append(element('dt', { document: documentRef, text: label }), element('dd', { document: documentRef, text: value == null || value === '' ? 'unknown' : String(value) }));
    }
    return list;
  }

  async function runSessionAction(action, sessionId, control) {
    const deleting = action === 'delete';
    let succeeded = false;
    const prompt = deleting
      ? `删除 Session ${sessionId}？该 Session 将从列表和关联 Route 中移除。`
      : `停止 Session ${sessionId}？当前运行将停止，但持久化记录会保留。`;
    if (!await confirm.ask(prompt, control)) return;
    setBusy(control, true, deleting ? '删除中' : '停止中');
    showMessage('');
    try {
      if (deleting) await api.delete('/api/admin/sessions/' + encodeURIComponent(sessionId), { signal: context.signal });
      else await api.post('/api/admin/sessions/' + encodeURIComponent(sessionId) + '/stop', {}, { signal: context.signal });
      succeeded = true;
      showMessage(deleting ? 'Session 已删除' : 'Session 已停止', 'success');
    } catch (error) {
      showMessage(error.message || 'Session 操作失败', 'danger');
    } finally {
      try {
        await loadSessions();
        if (!deleting || !succeeded) await openDetail(sessionId, control, false);
        else closeDetail();
      } catch (reloadError) {
        showMessage(reloadError.message || 'Session 状态重载失败', 'danger');
      }
      setBusy(control, false);
    }
  }

  function closeDetail() {
    detailId = null;
    persistFilters();
    clearCleanups(detailCleanups);
    drawer.close();
    context.navigate?.('#sessions?tab=' + filters.tab);
  }

  function renderRoutes() {
    routePanel.replaceChildren(
      element('div', { document: documentRef, className: 'note-box', text: '1:N Session 路由：一个 routeKey 绑定 { focusSessionId, sessions[], cwd, updatedAt }，普通消息发给焦点 session，非焦点 session 的 SSE 事件带 [session: wks_N] 标识回群。' }),
    );
    const card = element('div', { document: documentRef, className: 'card card-flat' });
    const toolbar = element('div', { document: documentRef, className: 'toolbar' });
    const title = element('div', { document: documentRef, attributes: { style: 'flex:1;font-weight:600;font-size:13.5px;' }, text: 'Route 映射表' });
    const addBtn = element('button', { document: documentRef, className: 'btn btn-primary', text: '+ 添加路由说明', attributes: { type: 'button' } });
    on(addBtn, 'click', () => showMessage('新建 Route 需飞书群内发送 /new 触发，此处仅作管理视图'), pageCleanups);
    toolbar.append(title, addBtn);
    const wrap = element('div', { document: documentRef, className: 'wide-table' });
    const table = element('table', { document: documentRef });
    const headRow = element('tr', { document: documentRef });
    for (const label of ['routeKey', '模式', '焦点 Session', '绑定 Session 数', 'cwd', '最近更新', '操作']) {
      headRow.append(element('th', { document: documentRef, text: label }));
    }
    table.append(element('thead', { document: documentRef }, headRow));
    const body = element('tbody', { document: documentRef });
    table.append(body);
    wrap.append(table);
    card.append(toolbar, wrap);
    routePanel.append(card);
    if (routes.length === 0) {
      body.append(element('tr', { document: documentRef }, element('td', { document: documentRef, attributes: { colspan: '7' }, text: '暂无 Route。' })));
    } else {
      for (const route of routes) body.append(renderRouteRow(route));
    }
  }

  function renderRouteRow(route) {
    const row = element('tr', { document: documentRef });
    const sessionCount = route.sessionCount || (route.sessions || route.sessionIds || []).length;
    const view = element('span', { document: documentRef, className: 'link', text: '查看' });
    on(view, 'click', () => openDetail(route.focusSessionId || (route.sessions || [])[0] || '', view, true), pageCleanups);
    const unbind = element('span', { document: documentRef, className: 'link link-red', text: '解绑' });
    on(unbind, 'click', () => showMessage('已解绑 route ' + route.routeKey + '（需群内 /stop 全部 session）'), pageCleanups);
    row.append(
      element('td', { document: documentRef, className: 'mono', text: route.routeKey }),
      element('td', { document: documentRef, text: route.mode || 'thread' }),
      element('td', { document: documentRef, className: 'mono', text: route.focusSessionId || '—' }),
      element('td', { document: documentRef, text: String(sessionCount) }),
      element('td', { document: documentRef, className: 'mono', text: compactPath(route.cwd, 48) }),
      element('td', { document: documentRef, className: 'mono', text: formatDateTime(route.updatedAt) }),
      element('td', { document: documentRef }, view, documentRef.createTextNode('  '), unbind),
    );
    return row;
  }

  const offDrawerClose = listen(drawer.closeButton, 'click', () => { if (detailId) closeDetail(); });
  const offDrawerEscape = listen(documentRef, 'keydown', event => { if (event.key === 'Escape' && detailId) closeDetail(); });
  pageCleanups.push(offDrawerClose, offDrawerEscape);
  pageCleanups.push(listen(context.root, 'walker:refresh', () => { loadSessions(); loadRoutes(); }));

  try {
    await Promise.all([loadSessions(), loadRoutes()]);
    commit(() => {
      context.root.scrollTop = initialScrollTop;
      filters.scrollTop = initialScrollTop;
      tabs.select(filters.tab === 'routes' ? 'routes' : 'sessions');
      context.root.scrollTop = initialScrollTop;
      filters.scrollTop = initialScrollTop;
    });
    if (detailId) await openDetail(detailId, null, false);
  } catch (error) {
    if (error?.code !== 'ABORTED') showMessage(error.message || '会话与路由加载失败', 'danger');
  }

  const cleanup = combineCleanups(
    () => { persistFilters(); },
    () => { active = false; },
    () => { clearCleanups(detailCleanups); },
    () => { clearCleanups(sessionRowCleanups); },
    () => { clearCleanups(sessionControlCleanups); },
    ...pageCleanups,
    tabs.cleanup,
    drawer.cleanup,
    context.confirm ? null : confirm.cleanup,
  );
  return { cleanup, drawer, tabs };
}
