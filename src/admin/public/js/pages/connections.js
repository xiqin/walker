import { element, listen, setBusy } from '../dom.js';
import { compactPath, formatDateTime } from '../format.js';
import { createToast } from '../components/feedback.js';
import { createStatusCard } from '../components/status-card.js';
import { createDataTable } from '../components/data-table.js';

const SENSITIVE_KEY = /token|secret|authorization|cookie|api[-_]?key|password/i;
const REFRESH_MS = 5000;

/** 挂载连接、主机运行时与 TUI Runtime 工作区。 */
export async function mount(context) {
  const documentRef = context.document || document;
  const page = element('div', { document: documentRef, className: 'page connections-page' });
  page.append(element('h1', { document: documentRef, className: 'visually-hidden', text: '连接与集成' }));
  const content = element('div', { document: documentRef, className: 'connections-workspace' });
  const toast = createToast({ document: documentRef });
  const detail = element('section', { document: documentRef, className: 'runtime-detail', attributes: { 'aria-live': 'polite' } });
  page.append(content, detail, toast.element);
  context.root.replaceChildren(page);

  let active = true;
  let loading = false;
  let forceQueued = false;
  let queuedResolvers = [];
  let detailController = null;
  let detailGeneration = 0;
  let model = null;
  const timerApi = context.window || window;

  async function load(options = {}) {
    if (!active) return;
    if (loading) {
      if (!options.force) return;
      forceQueued = true;
      return new Promise(resolve => queuedResolvers.push(resolve));
    }
    loading = true;
    if (!options.quiet) content.replaceChildren(element('p', { document: documentRef, className: 'muted', attributes: { style: 'padding:16px;' }, text: '正在检测连接状态…' }));
    try {
      const settled = await Promise.all([
        read(context, '/api/admin/status'), read(context, '/api/admin/agents'),
        read(context, '/api/admin/runtime'), read(context, '/api/admin/tui-runtimes'),
      ].map(async request => {
        try { return { value: await request }; } catch (error) { return { error }; }
      }));
      if (!active || !context.isCurrent()) return;
      model = { status: settled[0], agents: settled[1], runtime: settled[2], runtimes: settled[3] };
      context.commit(() => content.replaceChildren(renderWorkspace(documentRef, context, model, toast, detail, load, showRuntimeDetail)));
    } finally {
      loading = false;
      if (active && forceQueued) {
        forceQueued = false;
        const resolvers = queuedResolvers;
        queuedResolvers = [];
        await load({ quiet: true, force: true });
        resolvers.forEach(resolve => resolve());
      }
    }
  }

  async function showRuntimeDetail(runtimeId) {
    detailController?.abort();
    const controller = new AbortController();
    detailController = controller;
    const generation = ++detailGeneration;
    try {
      const runtime = sanitize(unwrap(await context.api.get(
        '/api/admin/tui-runtimes/' + encodeURIComponent(runtimeId), { signal: controller.signal })));
      if (!active || controller.signal.aborted || generation !== detailGeneration || !context.isCurrent()) return;
      context.commit(() => detail.replaceChildren(renderRuntimeDetail(documentRef, runtime)));
    } catch (error) {
      if (controller.signal.aborted || generation !== detailGeneration || error?.code === 'ABORTED') return;
      context.commit(() => detail.replaceChildren(element('p', { document: documentRef, className: 'feedback__error', text: error.message })));
    }
  }

  await load();
  const intervalId = timerApi.setInterval(() => active ? load({ quiet: true }) : undefined, REFRESH_MS);
  const offRefresh = listen(context.root, 'walker:refresh', () => load({ quiet: true, force: true }));
  return () => {
    if (!active) return;
    active = false;
    forceQueued = false;
    queuedResolvers.splice(0).forEach(resolve => resolve());
    detailGeneration++;
    detailController?.abort();
    timerApi.clearInterval(intervalId);
    offRefresh();
  };
}

function renderWorkspace(documentRef, context, model, toast, detail, reload, showRuntimeDetail) {
  const workspace = element('div', { document: documentRef, className: 'connections-workspace' });
  const status = model.status.value || {};
  const agents = normalizeList(model.agents.value);
  const runtime = model.runtime.value || {};
  const runtimes = normalizeList(model.runtimes.value);

  const connections = element('section', { document: documentRef, className: 'workspace-section' },
    element('div', { document: documentRef, className: 'section-title', text: '外部连接' }));
  const cards = element('div', { document: documentRef, className: 'grid grid-2' });
  cards.append(feishuCard(documentRef, context, status.feishu, toast, reload));
  const opencode = agents.find(item => item.name === 'opencode') || {};
  cards.append(opencodeCard(documentRef, context, status.opencode, opencode, toast, reload));
  cards.append(connectionCard(documentRef, context, 'TUI Bridge', status.tuiBridge, [], toast, reload));
  cards.append(connectionCard(documentRef, context, 'Runtime', status.runtimes, [['Runtime 数量', runtimes.length]], toast, reload));
  connections.append(cards);

  const agentSection = element('section', { document: documentRef, className: 'workspace-section' },
    element('div', { document: documentRef, className: 'section-title', text: 'Agent 扩展' }));
  const agentCard = element('div', { document: documentRef, className: 'card' });
  agentCard.append(renderAgentTable(documentRef));
  agentSection.append(agentCard);

  const runtimeForm = element('section', { document: documentRef, className: 'workspace-section' },
    element('div', { document: documentRef, className: 'section-title', text: 'Runtime 执行环境' }),
    element('div', { document: documentRef, className: 'section-sub', text: 'Runtime 决定 Agent CLI 在何处执行，而非独立的服务器集群' }));
  runtimeForm.append(renderRuntimeForm(documentRef, runtime));

  const hosts = element('section', { document: documentRef, className: 'workspace-section' },
    element('div', { document: documentRef, className: 'section-title', text: 'Windows / WSL' }));
  const hostsCard = element('div', { document: documentRef, className: 'card' });
  const hostGrid = element('div', { document: documentRef, className: 'grid grid-2' });
  hostGrid.append(hostCard(documentRef, 'Windows', runtime.windows));
  hostGrid.append(hostCard(documentRef, 'WSL', runtime.wsl));
  const runtimeCheck = createActionButton(documentRef, context, {
    label: '检测 Windows/WSL', target: 'Windows/WSL', url: '/api/admin/runtime/check', success: 'Windows/WSL 检测完成',
  }, toast, reload);
  hostsCard.append(hostGrid, runtimeCheck);
  hosts.append(hostsCard);

  const runtimeSection = element('section', { document: documentRef, className: 'workspace-section' },
    element('div', { document: documentRef, className: 'section-title', text: 'TUI Runtime' }));
  const runtimeCard = element('div', { document: documentRef, className: 'card' });
  if (model.runtimes.error) runtimeCard.append(element('p', { document: documentRef, className: 'feedback__error', text: model.runtimes.error.message }));
  else if (runtimes.length === 0) runtimeCard.append(element('p', { document: documentRef, text: '暂无 TUI Runtime' }));
  else runtimeCard.append(createRuntimeTable(documentRef, runtimes, showRuntimeDetail));
  runtimeSection.append(runtimeCard);

  for (const state of [model.status, model.agents, model.runtime]) {
    if (state.error) workspace.append(element('p', { document: documentRef, className: 'feedback__error', text: state.error.message }));
  }
  workspace.append(connections, agentSection, runtimeForm, hosts, runtimeSection);
  return workspace;
}

function feishuCard(documentRef, context, feishu = {}, toast, reload) {
  const card = element('div', { document: documentRef, className: 'card' });
  const header = element('div', { document: documentRef, attributes: { style: 'display:flex;justify-content:space-between;align-items:center;' } });
  const titleArea = element('div', { document: documentRef, attributes: { style: 'display:flex;gap:10px;align-items:center;' } });
  titleArea.append(
    element('div', { document: documentRef, className: 'stat-icon', attributes: { style: 'background:#2563eb;width:30px;height:30px;font-size:13px;' }, text: '◆' }),
    element('b', { document: documentRef, text: '飞书（Feishu）长连接' }),
  );
  header.append(titleArea, element('span', { document: documentRef, className: 'badge ' + badgeClass(feishu.status), text: badgeText(feishu.status) }));
  card.append(header);

  const fields = [
    ['App ID', feishu.appId || '未配置'],
    ['事件订阅', feishu.eventSubscription || 'im.message.receive_v1 · 长连接接收'],
    ['Route 模式', feishu.routeMode || 'FEISHU_ROUTE_MODE=thread'],
    ['进度样式', feishu.progressStyle || 'FEISHU_PROGRESS_STYLE=card'],
    ['表情回复', feishu.reactionEmoji || '收到: OnIt　完成: none'],
  ];
  let firstStat = true;
  for (const [label, value] of fields) {
    const row = element('div', { document: documentRef, className: 'stat-body' });
    if (firstStat) { row.setAttribute('style', 'margin-top:12px;'); firstStat = false; }
    row.append(element('span', { document: documentRef, text: label }), element('span', { document: documentRef, className: 'mono', text: value }));
    card.append(row);
  }

  const actionBar = element('div', { document: documentRef, attributes: { style: 'margin-top:10px;display:flex;gap:8px;' } });
  actionBar.append(
    createActionButton(documentRef, context, { label: '测试连接', target: '飞书', url: '/api/admin/feishu/check', success: '飞书连接测试完成' }, toast, reload),
    createDangerButton(documentRef, context, '断开连接', '飞书', toast, reload),
  );
  card.append(actionBar);
  return card;
}

function opencodeCard(documentRef, context, opencodeStatus = {}, opencodeAgent = {}, toast, reload) {
  const card = element('div', { document: documentRef, className: 'card' });
  const header = element('div', { document: documentRef, attributes: { style: 'display:flex;justify-content:space-between;align-items:center;' } });
  const titleArea = element('div', { document: documentRef, attributes: { style: 'display:flex;gap:10px;align-items:center;' } });
  titleArea.append(
    element('div', { document: documentRef, className: 'stat-icon', attributes: { style: 'background:#7c3aed;width:30px;height:30px;font-size:13px;' }, text: '</>' }),
    element('b', { document: documentRef, text: 'OpenCode Server' }),
  );
  header.append(titleArea, element('span', { document: documentRef, className: 'badge ' + badgeClass(opencodeStatus.status), text: badgeText(opencodeStatus.status) }));
  card.append(header);

  const fields = [
    ['Server URL', opencodeAgent.config?.serverUrl || '未知'],
    ['自动启动', opencodeAgent.config?.autostart === false ? 'OPENCODE_SERVER_AUTOSTART=false' : 'OPENCODE_SERVER_AUTOSTART=true'],
    ['Hook 自动纳入', opencodeAgent.config?.hookEnabled === false ? 'WALKER_OPENCODE_HOOK_ENABLED=false' : 'WALKER_OPENCODE_HOOK_ENABLED=true'],
    ['健康轮询间隔', opencodeAgent.config?.healthPollInterval || '5000ms'],
  ];
  let firstStat = true;
  for (const [label, value] of fields) {
    const row = element('div', { document: documentRef, className: 'stat-body' });
    if (firstStat) { row.setAttribute('style', 'margin-top:12px;'); firstStat = false; }
    row.append(element('span', { document: documentRef, text: label }), element('span', { document: documentRef, className: 'mono', text: value }));
    card.append(row);
  }

  const actionBar = element('div', { document: documentRef, attributes: { style: 'margin-top:10px;display:flex;gap:8px;' } });
  actionBar.append(
    createActionButton(documentRef, context, { label: '测试健康检查', target: 'OpenCode', url: '/api/admin/agents/opencode/check', success: 'OpenCode 检测完成' }, toast, reload),
    createActionButton(documentRef, context, { label: '重装 Plugin', target: 'OpenCode', url: '/api/admin/agents/opencode/ensure-ready', success: 'OpenCode Plugin 已重装' }, toast, reload),
  );
  card.append(actionBar);
  return card;
}

function renderAgentTable(documentRef) {
  const rows = [];
  for (const name of ['opencode', 'claude', 'codex']) {
    rows.push({
      agent: name,
      status: name === 'opencode' ? 'P0 已实现' : '预留扩展点',
      note: name === 'opencode' ? '通过 opencode serve HTTP API / SSE 控制' : (name === 'claude' ? 'Claude Code CLI，未来实现' : 'Codex CLI，未来实现'),
      action: name === 'opencode' ? '设为默认' : '尚未实现',
    });
  }
  return createDataTable({
    document: documentRef,
    caption: 'Agent 扩展',
    columns: [
      { key: 'agent', label: 'Agent', render: row => element('span', { document: documentRef, className: 'mono', text: row.agent }) },
      { key: 'status', label: '状态', render: row => element('span', { document: documentRef, className: 'badge ' + (row.agent === 'opencode' ? 'badge-green' : 'badge-gray'), text: row.status }) },
      { key: 'note', label: '说明' },
      { key: 'action', label: '操作', render: row => element('span', { document: documentRef, className: row.agent === 'opencode' ? 'link' : 'link', text: row.action, attributes: { style: row.agent !== 'opencode' ? 'color:var(--text-muted);cursor:not-allowed;' : '' } }) },
    ],
    rows,
  });
}

function renderRuntimeForm(documentRef, runtime) {
  const card = element('div', { document: documentRef, className: 'card' });
  const grid = element('div', { document: documentRef, className: 'form-grid' });
  const runtimeSelect = element('select', { document: documentRef, className: 'select', attributes: { 'aria-label': '默认 Runtime' } });
  for (const value of ['windows（本机直接运行）', 'wsl（通过 wsl.exe -d 运行）']) {
    const option = element('option', { document: documentRef, text: value }); option.value = value; runtimeSelect.append(option);
  }
  const distroInput = element('input', { document: documentRef, attributes: { type: 'text', 'aria-label': 'WSL 发行版', value: runtime.wsl?.distro || 'Ubuntu-24.04' } });
  grid.append(
    fieldGroup(documentRef, '默认 Runtime', 'WALKER_DEFAULT_RUNTIME', runtimeSelect),
    fieldGroup(documentRef, 'WSL 发行版', 'WALKER_WSL_DISTRO', distroInput),
  );
  card.append(grid);
  return card;
}

function fieldGroup(documentRef, label, envkey, control) {
  const wrap = element('div', { document: documentRef, className: 'field' });
  wrap.append(element('label', { document: documentRef }, element('span', { document: documentRef, text: label + ' ' }), element('span', { document: documentRef, className: 'envkey', text: envkey })), control);
  return wrap;
}

function connectionCard(documentRef, context, title, item = {}, details, toast, reload, actions = []) {
  const container = element('div', { document: documentRef, className: 'connection-card' });
  container.append(createStatusCard({
    document: documentRef, title, status: item?.status || 'unknown', description: item?.reason || '',
    details: [...details, ['最近检查', formatDateTime(item?.checkedAt)]],
  }));
  if (actions.length > 0) {
    const actionBar = element('div', { document: documentRef, className: 'connection-card__actions', attributes: { style: 'display:flex;gap:8px;margin-top:10px;' } });
    for (const action of actions) actionBar.append(createActionButton(documentRef, context, action, toast, reload));
    container.append(actionBar);
  }
  return container;
}

function hostCard(documentRef, title, value = {}) {
  const isWsl = title === 'WSL';
  const cwdKnown = value?.cwdChecked === true;
  const status = isWsl ? wslStatus(value, cwdKnown)
    : cwdKnown ? (value?.cwdExists ? 'healthy' : 'warning') : 'unknown';
  return createStatusCard({
    document: documentRef, title, status, description: value?.ipError || value?.cwdError || '',
    details: [
      ['类型', value?.type || title.toLowerCase()], ['环境', value?.distro || title],
      ['CWD', compactPath(value?.cwd)], ['CWD 可用', cwdKnown ? (value?.cwdExists ? '是' : '否') : '未检测'],
      ...(isWsl ? [['IP', value?.ip || '未检测']] : []),
    ],
  });
}

function wslStatus(value, cwdKnown) {
  if (value?.ipError || value?.cwdError) return 'warning';
  if (!value?.ipDetected) return 'unknown';
  if (!cwdKnown) return 'unknown';
  return value?.cwdExists ? 'healthy' : 'warning';
}

function createActionButton(documentRef, context, action, toast, reload) {
  const button = element('button', { document: documentRef, className: 'btn btn-sm', text: action.label,
    attributes: { type: 'button', 'aria-label': action.label + '：' + (action.target || action.label) } });
  listen(button, 'click', async () => {
    setBusy(button, true, '处理中');
    try {
      const result = unwrap(await context.api.post(action.url, {}, { signal: context.signal }));
      const failed = result?.healthy === false || result?.ready === false;
      toast.show(failed ? (result.error || action.label + '未通过') : action.success, failed ? 'warning' : 'success', 0);
      await reload({ quiet: true, force: true });
    } catch (error) {
      if (error?.code !== 'ABORTED') toast.show(error.message || '操作失败', 'danger', 0);
    } finally {
      setBusy(button, false);
    }
  });
  return button;
}

function createDangerButton(documentRef, context, label, target, toast, reload) {
  const button = element('button', { document: documentRef, className: 'btn btn-sm btn-danger', text: label,
    attributes: { type: 'button', 'aria-label': label + '：' + target } });
  listen(button, 'click', async () => {
    setBusy(button, true, '处理中');
    try {
      toast.show('已断开' + target + '长连接（需重启 Walker 恢复）', 'warning', 0);
      await reload({ quiet: true, force: true });
    } catch (error) {
      if (error?.code !== 'ABORTED') toast.show(error.message || '操作失败', 'danger', 0);
    } finally {
      setBusy(button, false);
    }
  });
  return button;
}

function createRuntimeTable(documentRef, runtimes, showRuntimeDetail) {
  return createDataTable({
    document: documentRef,
    caption: 'TUI Runtime 列表',
    columns: [
      { key: 'runtimeId', label: 'Runtime' }, { key: 'sessionId', label: 'OpenCode Session' },
      { key: 'cwd', label: 'CWD', render: row => compactPath(row.cwd) },
      { key: 'health', label: '健康', render: row => row.health?.reason || row.health?.status || '未知' },
      { key: 'lease', label: '租约', render: row => leaseText(row.lease) },
      { key: 'lastHeartbeatAt', label: '最近心跳', render: row => formatDateTime(row.lastHeartbeatAt) },
      { key: 'action', label: '操作', render: row => runtimeDetailButton(documentRef, row.runtimeId, showRuntimeDetail) },
    ],
    rows: runtimes.map(sanitize),
  });
}

function runtimeDetailButton(documentRef, runtimeId, showRuntimeDetail) {
  const button = element('button', { document: documentRef, className: 'btn btn-sm', text: '查看详情',
    attributes: { type: 'button', 'aria-label': '查看 Runtime ' + runtimeId + ' 详情' } });
  listen(button, 'click', async () => {
    button.disabled = true;
    try { await showRuntimeDetail(runtimeId); } finally { button.disabled = false; }
  });
  return button;
}

function renderRuntimeDetail(documentRef, runtime) {
  const section = element('div', { document: documentRef, className: 'runtime-detail__content' },
    element('div', { document: documentRef, className: 'section-title', text: 'Runtime 详情' }));
  const fields = [
    ['Runtime ID', runtime.runtimeId], ['OpenCode Session', runtime.sessionId], ['Walker Session', runtime.walkerSessionId],
    ['CWD', runtime.cwd], ['OpenCode 版本', runtime.opencodeVersion], ['Bridge 协议', '协议 ' + (runtime.bridgeProtocolVersion ?? '未知')],
    ['最近心跳', formatDateTime(runtime.lastHeartbeatAt)], ['租约', leaseText(runtime.lease)],
    ['剩余时间', formatDuration(runtime.lease?.remainingMs)], ['到期时间', formatDateTime(runtime.lease?.expiresAt)],
    ['健康', runtime.health?.status], ['原因', runtime.health?.reason || '无'],
  ];
  const list = element('dl', { document: documentRef, className: 'runtime-detail__fields' });
  for (const [label, value] of fields) list.append(element('dt', { document: documentRef, text: label }), element('dd', { document: documentRef, text: value ?? '未知' }));
  section.append(list);
  return section;
}

function leaseText(lease = {}) {
  if (lease.status === 'active') return '租约正常';
  if (lease.status === 'expiring') return '即将过期';
  if (lease.status === 'expired') return '已过期';
  return '租约未知';
}

function formatDuration(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return '未知';
  if (milliseconds <= 0) return '0 秒';
  return Math.ceil(milliseconds / 1000) + ' 秒';
}

function badgeClass(status) {
  if (status === 'healthy' || status === 'connected') return 'badge-green';
  if (status === 'warning') return 'badge-amber';
  if (status === 'failed' || status === 'error') return 'badge-red';
  return 'badge-gray';
}

function badgeText(status) {
  if (status === 'healthy' || status === 'connected') return '已连接';
  if (status === 'warning') return '警告';
  if (status === 'failed' || status === 'error') return '异常';
  return '未知';
}

async function read(context, url) {
  return sanitize(unwrap(await context.api.get(url, { signal: context.signal })));
}

function unwrap(response) {
  return response && response.ok === true && Object.prototype.hasOwnProperty.call(response, 'data') ? response.data : response;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.list) ? value.list : [];
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (!SENSITIVE_KEY.test(key)) result[key] = sanitize(child);
  }
  return result;
}
