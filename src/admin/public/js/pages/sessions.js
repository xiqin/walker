import { combineCleanups, element, listen, setBusy } from '../dom.js';
import { compactPath, formatDateTime, formatStatus, shortId } from '../format.js';
import { createDrawer } from '../components/drawer.js';
import { createTabs } from '../components/tabs.js';
import { createConfirm } from '../components/feedback.js';

const DEFAULT_FILTERS = {
  query: '',
  status: '',
  transport: '',
  route: '',
  orphan: false,
  tab: 'sessions',
  scrollTop: 0,
};

/** 按关键词、状态、来源、Route 和游离状态执行本地 AND 过滤。 */
export function filterSessions(sessions, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  const status = String(filters.status || '');
  const transport = String(filters.transport || '');
  const route = String(filters.route || '');
  const orphan = Boolean(filters.orphan);
  return (sessions || []).filter(session => {
    const routeKeys = Array.isArray(session.routeKeys) ? session.routeKeys : [];
    const searchable = [session.id, session.title, session.cwd, session.opencodeSessionId, session.runtimeId, ...routeKeys]
      .filter(value => value != null).join(' ').toLowerCase();
    return (!query || searchable.includes(query))
      && (!status || session.status === status)
      && (!transport || (session.transport || 'unknown') === transport)
      && (!route || routeKeys.includes(route))
      && (!orphan || routeKeys.length === 0);
  });
}

/** 挂载 Session/Route 双 Tab 工作区。 */
export async function mount(context) {
  const documentRef = context.document || document;
  const api = context.api;
  const pageCleanups = [];
  const sessionControlCleanups = [];
  const sessionCardCleanups = [];
  const routeCleanups = [];
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
  const routeDraft = { routeKey: '', sessionId: '', cwd: '' };

  const page = element('section', { document: documentRef, className: 'sessions-workspace', attributes: { 'aria-labelledby': 'sessions-title' } });
  const heading = element('h1', { document: documentRef, text: '会话与路由', attributes: { id: 'sessions-title' } });
  const description = element('p', { document: documentRef, text: '检查 Session 运行态，并管理 Route 的成员、焦点和工作目录。' });
  const message = element('p', { document: documentRef, className: 'operation-feedback', attributes: { role: 'status', 'aria-live': 'polite' } });
  const sessionPanel = element('section', { document: documentRef, className: 'sessions-panel' });
  const routePanel = element('section', { document: documentRef, className: 'routes-panel' });
  const drawer = createDrawer({ document: documentRef, id: 'session-detail', title: 'Session 详情' });
  const confirm = context.confirm || createConfirm({ document: documentRef, title: '确认危险操作' });
  const tabs = createTabs({
    document: documentRef,
    label: 'Session 与 Route',
    selected: filters.tab === 'routes' ? 'routes' : 'sessions',
    tabs: [
      { id: 'sessions', label: 'Session', panel: sessionPanel },
      { id: 'routes', label: 'Route', panel: routePanel },
    ],
    onChange(id) {
      filters.tab = id;
      persistFilters();
    },
  });
  page.append(heading, description, tabs.element, message, sessionPanel, routePanel, drawer.element);
  if (!context.confirm) page.append(confirm.element);
  context.root.replaceChildren(page);

  /** 读取统一响应 envelope 中的业务数据。 */
  function responseData(response) {
    return response && Object.hasOwn(response, 'data') ? response.data : response;
  }

  /** 页面仍有效时提交 DOM 变更。 */
  function commit(callback) {
    if (!active || context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return;
    if (context.commit) context.commit(callback);
    else callback();
  }

  /** 保存筛选、Tab 与滚动位置。 */
  function persistFilters() {
    filters.scrollTop = context.root.scrollTop || 0;
    context.store?.setPageFilters?.('sessions', filters);
  }

  /** 创建带可访问名称的表单控件。 */
  function field(labelText, control) {
    const label = element('label', { document: documentRef, className: 'field' });
    label.append(element('span', { document: documentRef, text: labelText }), control);
    return label;
  }

  /** 创建 select 并设置初始值。 */
  function selectControl(name, label, values, selected) {
    const select = element('select', { document: documentRef, attributes: { name, 'aria-label': label } });
    for (const [value, text] of values) {
      const option = element('option', { document: documentRef, text, attributes: { value } });
      option.value = value;
      select.append(option);
    }
    select.value = selected || '';
    return select;
  }

  /** 释放一个重渲染区域上一轮注册的监听和节点闭包。 */
  function clearCleanups(cleanups) {
    while (cleanups.length > 0) cleanups.pop()();
  }

  /** 为控件注册到指定生命周期的事件。 */
  function on(target, type, handler, cleanups = pageCleanups) {
    const cleanup = listen(target, type, handler);
    cleanups.push(cleanup);
    return cleanup;
  }

  /** 显示稳定的操作反馈。 */
  function showMessage(value, tone = 'neutral') {
    commit(() => {
      message.textContent = value ? String(value) : '';
      message.dataset.tone = tone;
    });
  }

  /** 从服务端重拉 Session 列表。 */
  async function loadSessions() {
    const payload = responseData(await api.get('/api/admin/sessions', { signal: context.signal }));
    sessions = Array.isArray(payload?.list) ? payload.list : [];
    commit(renderSessions);
  }

  /** 从服务端重拉 Route 列表。 */
  async function loadRoutes() {
    const payload = responseData(await api.get('/api/admin/routes', { signal: context.signal }));
    routes = Array.isArray(payload?.list) ? payload.list : [];
    commit(renderRoutes);
  }

  /** 渲染 Session 筛选和高密度列表。 */
  function renderSessions() {
    clearCleanups(sessionCardCleanups);
    clearCleanups(sessionControlCleanups);
    const controls = element('form', { document: documentRef, className: 'filter-grid', attributes: { 'aria-label': 'Session 过滤' } });
    const query = element('input', { document: documentRef, attributes: { name: 'session-query', type: 'search', 'aria-label': '搜索 Session', placeholder: 'ID、标题、CWD 或 Route' } });
    query.value = filters.query;
    const statuses = [...new Set(sessions.map(item => item.status).filter(Boolean))];
    const transports = [...new Set(sessions.map(item => item.transport || 'unknown'))];
    const routeKeys = [...new Set(sessions.flatMap(item => item.routeKeys || []))];
    const status = selectControl('session-status', '状态', [['', '全部状态'], ...statuses.map(value => [value, value])], filters.status);
    const transport = selectControl('session-transport', '来源', [['', '全部来源'], ...transports.map(value => [value, value])], filters.transport);
    const route = selectControl('session-route', 'Route', [['', '全部 Route'], ...routeKeys.map(value => [value, value])], filters.route);
    const orphan = element('input', { document: documentRef, attributes: { name: 'session-orphan', type: 'checkbox', 'aria-label': '仅游离 Session' } });
    orphan.checked = filters.orphan;
    controls.append(field('搜索', query), field('状态', status), field('来源', transport), field('Route', route), field('仅游离', orphan));
    const list = element('div', { document: documentRef, className: 'session-list', attributes: { 'aria-live': 'polite' } });

    function refreshLocalList() {
      clearCleanups(sessionCardCleanups);
      const visible = filterSessions(sessions, filters);
      list.replaceChildren();
      if (visible.length === 0) {
        list.append(element('p', { document: documentRef, text: '没有匹配的 Session。' }));
        return;
      }
      for (const session of visible) list.append(renderSessionCard(session));
    }

    on(query, 'input', () => { filters.query = query.value; persistFilters(); refreshLocalList(); }, sessionControlCleanups);
    on(status, 'change', () => { filters.status = status.value; persistFilters(); refreshLocalList(); }, sessionControlCleanups);
    on(transport, 'change', () => { filters.transport = transport.value; persistFilters(); refreshLocalList(); }, sessionControlCleanups);
    on(route, 'change', () => { filters.route = route.value; persistFilters(); refreshLocalList(); }, sessionControlCleanups);
    on(orphan, 'change', () => { filters.orphan = orphan.checked; persistFilters(); refreshLocalList(); }, sessionControlCleanups);
    refreshLocalList();
    sessionPanel.replaceChildren(controls, list);
  }

  /** 渲染单个 Session，只提供打开详情而不暴露危险操作。 */
  function renderSessionCard(session) {
    const card = element('article', { document: documentRef, className: 'session-card' });
    const status = formatStatus(session.status);
    const health = session.health?.status || 'unknown';
    const focusRoute = session.focusRouteKeys?.[0] || '无焦点 Route';
    const button = element('button', { document: documentRef, text: '查看详情', attributes: { type: 'button', 'aria-label': '查看 Session ' + session.id + ' 详情' } });
    card.append(
      element('h2', { document: documentRef, text: (session.title || '未命名 Session') + ' · ' + shortId(session.id) }),
      detailList([
        ['状态', status.icon + ' ' + (session.status || 'unknown')],
        ['来源', session.transport || 'unknown'],
        ['焦点 Route', focusRoute],
        ['Runtime', session.runtime || 'unknown'],
        ['OpenCode', session.opencodeSessionId || 'unknown'],
        ['健康', health],
        ['CWD', compactPath(session.cwd, 48)],
        ['最近活动', formatDateTime(session.lastActiveAt)],
      ]),
      button,
    );
    on(button, 'click', () => openDetail(session.id, button, true), sessionCardCleanups);
    return card;
  }

  /** 生成语义化键值详情。 */
  function detailList(entries) {
    const list = element('dl', { document: documentRef, className: 'detail-list' });
    for (const [label, value] of entries) {
      list.append(element('dt', { document: documentRef, text: label }), element('dd', { document: documentRef, text: value == null || value === '' ? 'unknown' : String(value) }));
    }
    return list;
  }

  /** 加载并打开可深链恢复的 Session 详情。 */
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

  /** 渲染完整运行详情、时间线和详情内危险区。 */
  function renderSessionDetail(session) {
    clearCleanups(detailCleanups);
    const content = element('div', { document: documentRef, className: 'session-detail' });
    const timeline = element('ol', { document: documentRef, className: 'timeline' });
    for (const event of session.timeline || []) {
      timeline.append(element('li', { document: documentRef, text: [event.type || 'event', event.message || '', formatDateTime(event.timestamp || event.createdAt)].join(' · ') }));
    }
    if ((session.timeline || []).length === 0) timeline.append(element('li', { document: documentRef, text: '暂无时间线' }));
    const stop = element('button', { document: documentRef, className: 'button button--danger', text: '停止 Session', attributes: { type: 'button' } });
    const remove = element('button', { document: documentRef, className: 'button button--danger', text: '删除 Session', attributes: { type: 'button' } });
    content.append(
      element('h3', { document: documentRef, text: session.title || session.id }),
      detailList([
        ['Session ID', session.id],
        ['状态', session.status || 'unknown'],
        ['Route', (session.routeKeys || []).join(', ') || 'unknown'],
        ['焦点 Route', (session.focusRouteKeys || []).join(', ') || 'unknown'],
        ['Runtime ID', session.runtimeId || 'unknown'],
        ['OpenCode Session', session.opencodeSessionId || 'unknown'],
        ['Transport', session.transport || 'unknown'],
        ['Watch', session.watch ? (session.watch.active ? 'active · ' + (session.watch.mode || 'unknown') : 'inactive') : 'unknown'],
        ['Health', session.health?.status || 'unknown'],
        ['Health 原因', session.health?.reason || 'unknown'],
        ['最近心跳', formatDateTime(session.lastHeartbeatAt)],
        ['当前 Turn', session.currentTurn?.state || session.currentTurn?.status || 'unknown'],
        ['CWD', session.cwd || 'unknown'],
        ['最近活动', formatDateTime(session.lastActiveAt)],
      ]),
      element('h3', { document: documentRef, text: '时间线' }), timeline,
      element('section', { document: documentRef, className: 'danger-zone', attributes: { 'aria-label': 'Session 危险操作' } },
        element('h3', { document: documentRef, text: '危险操作' }), stop, remove),
    );
    on(stop, 'click', () => runSessionAction('stop', session.id, stop), detailCleanups);
    on(remove, 'click', () => runSessionAction('delete', session.id, remove), detailCleanups);
    return content;
  }

  /** 确认 Session 危险操作，并在成功或失败后以服务端状态为准。 */
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

  /** 关闭详情并回到保留当前上下文的列表 URL。 */
  function closeDetail() {
    detailId = null;
    persistFilters();
    clearCleanups(detailCleanups);
    drawer.close();
    context.navigate?.('#sessions?tab=' + filters.tab);
  }

  /** 渲染 Route v3 状态、成员和操作区。 */
  function renderRoutes() {
    clearCleanups(routeCleanups);
    const routeKeys = routes.map(route => route.routeKey);
    if (!routeKeys.includes(routeDraft.routeKey)) routeDraft.routeKey = routeKeys[0] || '';
    const routeSelect = selectControl('route-key', '目标 Route', routeKeys.map(value => [value, value]), routeDraft.routeKey);
    const sessionInput = element('input', { document: documentRef, attributes: { name: 'route-session-id', type: 'text', 'aria-label': 'Session ID', placeholder: 'wks_...' } });
    const cwdInput = element('input', { document: documentRef, attributes: { name: 'route-cwd', type: 'text', 'aria-label': 'Route CWD', placeholder: '绝对目录路径' } });
    sessionInput.value = routeDraft.sessionId;
    cwdInput.value = routeDraft.cwd;
    on(routeSelect, 'change', () => { routeDraft.routeKey = routeSelect.value; }, routeCleanups);
    on(sessionInput, 'input', () => { routeDraft.sessionId = sessionInput.value; }, routeCleanups);
    on(cwdInput, 'input', () => { routeDraft.cwd = cwdInput.value; }, routeCleanups);
    const actions = element('div', { document: documentRef, className: 'route-actions', attributes: { 'aria-label': 'Route 操作' } });
    const definitions = [
      ['add', '添加 Session'],
      ['focus', '切换焦点'],
      ['remove', '移除成员'],
      ['cwd', '修改 CWD'],
      ['cleanup', '清理悬空 Route'],
      ['delete', '删除整条 Route'],
    ];
    for (const [action, label] of definitions) {
      const button = element('button', { document: documentRef, className: action === 'delete' || action === 'remove' || action === 'cleanup' ? 'button button--danger' : 'button', text: label, attributes: { type: 'button' } });
      on(button, 'click', () => runRouteAction(action, { routeSelect, sessionInput, cwdInput, button }), routeCleanups);
      actions.append(button);
    }
    const toolbar = element('section', { document: documentRef, className: 'route-toolbar', attributes: { 'aria-label': 'Route v3 管理' } },
      field('Route', routeSelect), field('Session ID', sessionInput), field('CWD', cwdInput), actions);
    const list = element('div', { document: documentRef, className: 'route-list' });
    if (routes.length === 0) list.append(element('p', { document: documentRef, text: '暂无 Route。' }));
    for (const route of routes) list.append(renderRouteCard(route));
    routePanel.replaceChildren(toolbar, list);
  }

  /** 展示 Route 1:N 成员、焦点、CWD、状态和更新时间。 */
  function renderRouteCard(route) {
    const card = element('article', { document: documentRef, className: 'route-card' });
    const members = element('ul', { document: documentRef, className: 'route-members' });
    const summaries = new Map((route.activeSessions || []).map(item => [item.id, item]));
    for (const sessionId of route.sessions || route.sessionIds || []) {
      const summary = summaries.get(sessionId);
      const focus = sessionId === route.focusSessionId;
      members.append(element('li', { document: documentRef, text: `${focus ? '焦点 · ' : '成员 · '}${sessionId}${summary?.title ? ' · ' + summary.title : ''}${summary?.status ? ' · ' + summary.status : ''}` }));
    }
    if (members.children.length === 0) members.append(element('li', { document: documentRef, text: '无成员' }));
    const health = route.dangling ? '悬空' : '正常';
    card.append(
      element('h2', { document: documentRef, text: route.routeKey }),
      detailList([
        ['状态', health],
        ['焦点', route.focusSessionId || 'unknown'],
        ['CWD', route.cwd || 'unknown'],
        ['更新时间', formatDateTime(route.updatedAt)],
      ]),
      element('h3', { document: documentRef, text: '成员' }), members,
    );
    return card;
  }

  /** 执行 Route 明确写 API；无论结果如何都重新读取服务端状态。 */
  async function runRouteAction(action, controls) {
    const routeKey = controls.routeSelect.value;
    const sessionId = controls.sessionInput.value.trim();
    const cwd = controls.cwdInput.value.trim();
    routeDraft.routeKey = routeKey;
    routeDraft.sessionId = sessionId;
    routeDraft.cwd = cwd;
    const encodedRoute = encodeURIComponent(routeKey);
    let confirmation = null;
    if (action === 'remove') confirmation = `从 Route ${routeKey} 移除成员 ${sessionId}？其他成员和整条 Route 将保留。`;
    if (action === 'cleanup') confirmation = '清理全部悬空 Route？会移除缺失或已删除的成员、在焦点失效时重选首个有效成员；只有没有有效成员时才删除整条 Route。';
    if (action === 'delete') confirmation = `删除整条 Route ${routeKey}？该 Route 的全部成员关系、焦点和 CWD 将被删除。`;
    if (confirmation && !await confirm.ask(confirmation, controls.button)) return;
    setBusy(controls.button, true, '处理中');
    showMessage('');
    try {
      if (action === 'add') await api.post(`/api/admin/routes/${encodedRoute}/sessions`, { sessionId }, { signal: context.signal });
      if (action === 'focus') await api.patch(`/api/admin/routes/${encodedRoute}/focus`, { sessionId }, { signal: context.signal });
      if (action === 'remove') await api.delete(`/api/admin/routes/${encodedRoute}/sessions/${encodeURIComponent(sessionId)}`, { signal: context.signal });
      if (action === 'cwd') await api.patch(`/api/admin/routes/${encodedRoute}`, { cwd }, { signal: context.signal });
      if (action === 'cleanup') await api.post('/api/admin/routes/cleanup-dangling', { confirm: true }, { signal: context.signal });
      if (action === 'delete') await api.delete(`/api/admin/routes/${encodedRoute}`, { signal: context.signal, body: { confirm: true } });
      showMessage('Route 状态已更新', 'success');
    } catch (error) {
      showMessage(error.message || 'Route 操作失败', 'danger');
    } finally {
      try {
        await loadRoutes();
        await loadSessions();
      } catch (reloadError) {
        showMessage(reloadError.message || 'Route 状态重载失败', 'danger');
      }
      setBusy(controls.button, false);
    }
  }

  const offDrawerClose = listen(drawer.closeButton, 'click', () => {
    if (detailId) closeDetail();
  });
  const offDrawerEscape = listen(documentRef, 'keydown', event => {
    if (event.key === 'Escape' && detailId) closeDetail();
  });
  pageCleanups.push(offDrawerClose, offDrawerEscape);

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
    () => { clearCleanups(routeCleanups); },
    () => { clearCleanups(sessionCardCleanups); },
    () => { clearCleanups(sessionControlCleanups); },
    ...pageCleanups,
    tabs.cleanup,
    drawer.cleanup,
    context.confirm ? null : confirm.cleanup,
  );
  return { cleanup, drawer, tabs };
}
