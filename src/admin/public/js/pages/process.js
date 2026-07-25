import { element, listen, setBusy } from '../dom.js';
import { createConfirm, createToast } from '../components/feedback.js';

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

function unwrap(response) {
  return response && response.ok === true && Object.prototype.hasOwnProperty.call(response, 'data') ? response.data : response;
}

const COMMAND_REFERENCE = Object.freeze([
  ['walker', '前台运行（默认），Ctrl+C / 关闭终端即停止'],
  ['walker start', '后台守护进程启动'],
  ['walker stop', '停止后台进程'],
  ['walker status', '查看后台进程状态和最近日志'],
  ['walker logs [N]', '查看最近 N 行日志（默认 80）'],
  ['walker help', '显示帮助'],
]);

/** 挂载进程管理页：守护进程状态、进程控制与子命令参考。 */
export async function mount(context) {
  const documentRef = context.document || document;
  const page = element('div', { document: documentRef, className: 'page process-page' });
  page.append(element('h1', { document: documentRef, className: 'visually-hidden', text: '进程管理' }));
  const toast = createToast({ document: documentRef });
  const confirm = createConfirm({ document: documentRef, title: '确认停止服务' });

  const statusTable = element('table', { document: documentRef, className: 'kv-table process-status-row' });
  const tbody = element('tbody', { document: documentRef });
  statusTable.append(tbody);
  const statusCard = element('div', { document: documentRef, className: 'card' },
    element('div', { document: documentRef, className: 'section-title', text: '守护进程状态' }), statusTable);

  const buttons = element('div', { document: documentRef, className: 'process-controls' });
  const controlCard = element('div', { document: documentRef, className: 'card' },
    element('div', { document: documentRef, className: 'section-title', text: '进程控制' }), buttons);

  page.append(element('div', { document: documentRef, className: 'grid grid-2-1' }, statusCard, controlCard));

  const refHead = element('thead', { document: documentRef }, element('tr', { document: documentRef },
    element('th', { document: documentRef, text: '命令' }), element('th', { document: documentRef, text: '说明' })));
  const refBody = element('tbody', { document: documentRef });
  for (const [cmd, desc] of COMMAND_REFERENCE) {
    refBody.append(element('tr', { document: documentRef }, element('td', { document: documentRef, text: cmd }), element('td', { document: documentRef, text: desc })));
  }
  const refTable = element('table', { document: documentRef, className: 'cmd-table' });
  refTable.append(refHead, refBody);
  page.append(element('div', { document: documentRef, className: 'card process-section-ref' },
    element('div', { document: documentRef, className: 'section-title', text: '子命令参考' }), refTable));
  page.append(toast.element, confirm.element);
  context.root.replaceChildren(page);

  const cleanups = [];
  cleanups.push(listen(context.root, 'walker:refresh', () => loadStatus()));

  let isLoading = false;

  function showLoading() {
    isLoading = true;
    tbody.replaceChildren(element('tr', { document: documentRef },
      element('td', { document: documentRef, attributes: { colspan: '2' } },
        element('span', { document: documentRef, className: 'spin', attributes: { style: 'margin-right:8px;' } }),
        documentRef.createTextNode('加载中...'))));
  }

  function showError(error) {
    tbody.replaceChildren(element('tr', { document: documentRef },
      element('td', { document: documentRef, attributes: { colspan: '2' } })));
    const retryBtn = element('button', { document: documentRef, className: 'btn btn-sm', text: '重试', attributes: { type: 'button', style: 'margin-top:8px;' } });
    listen(retryBtn, 'click', () => loadStatus());
    const errorCell = tbody.querySelector('td');
    if (errorCell) {
      errorCell.append(
        element('div', { document: documentRef, className: 'feedback__error', text: error.message || '加载失败' }),
        retryBtn,
      );
    }
  }

  function showStatus(proc) {
    const isRunning = !!proc.pid;
    const statusBadge = isRunning
      ? element('span', { document: documentRef, className: 'badge badge-green', text: '运行中' })
      : element('span', { document: documentRef, className: 'badge badge-gray', text: '未检测到进程' });
    const rows = [
      ['运行状态', statusBadge.outerHTML],
      ['运行模式', 'walker start（后台守护）'],
      ['PID', proc.pid || '未知'],
      ['运行时长', formatUptime(proc.uptime)],
      ['版本', proc.version || '未知'],
      ['日志文件', 'logs/walker.log'],
      ['后台标准输出', 'logs/walker.out.log'],
      ['后台错误输出', 'logs/walker.err.log'],
    ];
    tbody.replaceChildren();
    for (const [label, value] of rows) {
      const td = element('td', { document: documentRef, className: 'mono', text: String(value) });
      if (label === '运行状态') {
        td.innerHTML = '';
        td.append(isRunning
          ? element('span', { document: documentRef, className: 'badge badge-green', text: '运行中' })
          : element('span', { document: documentRef, className: 'badge badge-gray', text: '未检测到进程' }));
      }
      tbody.append(element('tr', { document: documentRef },
        element('td', { document: documentRef, text: label }),
        td));
    }
  }

  async function loadStatus() {
    if (isLoading) return;
    showLoading();
    try {
      const overview = unwrap(await context.api.get('/api/admin/overview', { signal: context.signal }));
      const proc = (overview && overview.process) || {};
      showStatus(proc);
    } catch (error) {
      if (error?.code !== 'ABORTED') showError(error);
    } finally {
      isLoading = false;
    }
  }

  const statusBtn = element('button', { document: documentRef, className: 'btn', text: 'walker status', attributes: { type: 'button' } });
  listen(statusBtn, 'click', () => toast.show('请在终端执行 `walker status` 查看进程状态', 'neutral', 0));
  const logsBtn = element('button', { document: documentRef, className: 'btn', text: 'walker logs 80', attributes: { type: 'button' } });
  listen(logsBtn, 'click', () => context.navigate('#logs'));
  const fgBtn = element('button', { document: documentRef, className: 'btn btn-primary', text: 'walker（前台运行）', attributes: { type: 'button' } });
  listen(fgBtn, 'click', () => toast.show('前台运行需在终端执行 walker（Ctrl+C 停止）', 'neutral', 0));
  buttons.append(statusBtn, logsBtn, fgBtn);

  const stopZone = element('div', { document: documentRef, className: 'danger-zone' });
  const stopBtn = element('button', { document: documentRef, className: 'btn btn-danger-solid', text: 'walker stop', attributes: { type: 'button' } });
  listen(stopBtn, 'click', async () => {
    const ok = await confirm.ask('walker stop 将终止后台守护进程，所有活跃 session 将失去桥接（OpenCode 本身不受影响）。确认继续？', stopBtn);
    if (!ok) return;
    setBusy(stopBtn, true, '停止中');
    try {
      await context.api.post('/api/admin/service/stop', { confirm: true }, { signal: context.signal });
      toast.show('已执行 walker stop，进程已停止', 'success', 0);
    } catch (error) {
      if (error?.code !== 'ABORTED') toast.show(error.message || '停止失败', 'danger', 0);
    } finally {
      setBusy(stopBtn, false);
    }
  });
  stopZone.append(stopBtn);
  buttons.append(stopZone);

  await loadStatus();
  return () => { for (const dispose of cleanups) dispose(); confirm.cleanup(); };
}
