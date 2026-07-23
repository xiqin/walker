import { element, listen, setBusy } from '../dom.js';
import { compactPath, formatDateTime } from '../format.js';
import { createFeedback, createToast } from '../components/feedback.js';
import { createStatusCard } from '../components/status-card.js';
import { createDataTable } from '../components/data-table.js';

const SENSITIVE_KEY = /token|secret|authorization|cookie|api[-_]?key|password/i;
const REFRESH_MS = 5000;

/** 挂载连接、主机运行时与 TUI Runtime 工作区。 */
export async function mount(context) {
  const documentRef = context.document || document;
  const page = element('div', { document: documentRef, className: 'page connections-page' });
  const feedback = createFeedback({ document: documentRef });
  const toast = createToast({ document: documentRef });
  const detail = element('section', { document: documentRef, className: 'runtime-detail', attributes: { 'aria-live': 'polite' } });
  page.append(element('header', { document: documentRef, className: 'page-header' },
    element('h1', { document: documentRef, text: '连接与运行时' }),
    element('p', { document: documentRef, className: 'muted', text: '统一检测飞书、OpenCode、TUI Bridge、Runtime 与 Windows/WSL。' })),
  feedback.element, detail, toast.element);
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
    if (!options.quiet) feedback.showLoading('正在检测连接状态');
    try {
      const settled = await Promise.all([
        read(context, '/api/admin/status'), read(context, '/api/admin/agents'),
        read(context, '/api/admin/runtime'), read(context, '/api/admin/tui-runtimes'),
      ].map(async request => {
        try { return { value: await request }; } catch (error) { return { error }; }
      }));
      if (!active || !context.isCurrent()) return;
      model = { status: settled[0], agents: settled[1], runtime: settled[2], runtimes: settled[3] };
      context.commit(() => feedback.showContent(renderWorkspace(documentRef, context, model, toast, detail, load, showRuntimeDetail)));
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
  return () => {
    if (!active) return;
    active = false;
    forceQueued = false;
    queuedResolvers.splice(0).forEach(resolve => resolve());
    detailGeneration++;
    detailController?.abort();
    timerApi.clearInterval(intervalId);
  };
}

function renderWorkspace(documentRef, context, model, toast, detail, reload, showRuntimeDetail) {
  const workspace = element('div', { document: documentRef, className: 'connections-workspace' });
  const status = model.status.value || {};
  const agents = normalizeList(model.agents.value);
  const runtime = model.runtime.value || {};
  const runtimes = normalizeList(model.runtimes.value);

  const connections = element('section', { document: documentRef, className: 'workspace-section' },
    element('h2', { document: documentRef, text: '服务连接' }));
  const cards = element('div', { document: documentRef, className: 'status-grid' });
  cards.append(connectionCard(documentRef, context, '飞书', status.feishu, [], toast, reload));
  const opencode = agents.find(item => item.name === 'opencode') || {};
  cards.append(connectionCard(documentRef, context, 'OpenCode', status.opencode, [
    ['端点', opencode.config?.serverUrl || '未知'], ['自动恢复', opencode.config?.autostart === false ? '关闭' : '开启'],
  ], toast, reload, [
    { label: '检测 OpenCode', target: 'OpenCode', url: '/api/admin/agents/opencode/check', success: 'OpenCode 检测完成' },
    { label: '恢复 OpenCode', target: 'OpenCode', url: '/api/admin/agents/opencode/ensure-ready', success: 'OpenCode 已恢复' },
  ]));
  cards.append(connectionCard(documentRef, context, 'TUI Bridge', status.tuiBridge, [], toast, reload));
  cards.append(connectionCard(documentRef, context, 'Runtime', status.runtimes, [['Runtime 数量', runtimes.length]], toast, reload));
  connections.append(cards);

  const hosts = element('section', { document: documentRef, className: 'workspace-section' },
    element('h2', { document: documentRef, text: 'Windows / WSL' }));
  const hostGrid = element('div', { document: documentRef, className: 'status-grid' });
  hostGrid.append(hostCard(documentRef, 'Windows', runtime.windows));
  hostGrid.append(hostCard(documentRef, 'WSL', runtime.wsl));
  const runtimeCheck = createActionButton(documentRef, context, {
    label: '检测 Windows/WSL', target: 'Windows/WSL', url: '/api/admin/runtime/check', success: 'Windows/WSL 检测完成',
  }, toast, reload);
  hosts.append(hostGrid, runtimeCheck);

  const runtimeSection = element('section', { document: documentRef, className: 'workspace-section' },
    element('h2', { document: documentRef, text: 'TUI Runtime' }));
  if (model.runtimes.error) runtimeSection.append(element('p', { document: documentRef, className: 'feedback__error', text: model.runtimes.error.message }));
  else if (runtimes.length === 0) runtimeSection.append(element('p', { document: documentRef, text: '暂无 TUI Runtime' }));
  else runtimeSection.append(createRuntimeTable(documentRef, runtimes, showRuntimeDetail));

  for (const state of [model.status, model.agents, model.runtime]) {
    if (state.error) workspace.append(element('p', { document: documentRef, className: 'feedback__error', text: state.error.message }));
  }
  workspace.append(connections, hosts, runtimeSection);
  return workspace;
}

function connectionCard(documentRef, context, title, item = {}, details, toast, reload, actions = []) {
  const container = element('div', { document: documentRef, className: 'connection-card' });
  container.append(createStatusCard({
    document: documentRef, title, status: item?.status || 'unknown', description: item?.reason || '',
    details: [...details, ['最近检查', formatDateTime(item?.checkedAt)]],
  }));
  if (actions.length > 0) {
    const actionBar = element('div', { document: documentRef, className: 'connection-card__actions' });
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
  const button = element('button', { document: documentRef, className: 'button', text: action.label,
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
  const button = element('button', { document: documentRef, className: 'button', text: '查看详情',
    attributes: { type: 'button', 'aria-label': '查看 Runtime ' + runtimeId + ' 详情' } });
  listen(button, 'click', async () => {
    button.disabled = true;
    try {
      await showRuntimeDetail(runtimeId);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function renderRuntimeDetail(documentRef, runtime) {
  const section = element('div', { document: documentRef, className: 'runtime-detail__content' },
    element('h2', { document: documentRef, text: 'Runtime 详情' }));
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
