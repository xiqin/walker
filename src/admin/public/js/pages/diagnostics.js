import { element, listen, replace, setBusy } from '../dom.js';

function responseData(response) {
  return response?.data ?? response ?? {};
}

function defaultDownload(documentRef, name, data) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const link = element('a', { document: documentRef, attributes: { href: url, download: name } });
  link.click();
  URL.revokeObjectURL(url);
}

const STATUS_COLOR = { pass: 'green', healthy: 'green', warn: 'amber', warning: 'amber', fail: 'red', failed: 'red', unknown: 'gray' };

function badgeClass(status) {
  if (status === 'pass' || status === 'healthy') return 'badge-green';
  if (status === 'warn' || status === 'warning') return 'badge-amber';
  if (status === 'fail' || status === 'failed') return 'badge-amber';
  return 'badge-gray';
}

function badgeText(status, reason) {
  if (status === 'pass' || status === 'healthy') return '通过';
  if (status === 'warn' || status === 'warning') return reason || '警告';
  if (status === 'fail' || status === 'failed') return reason || '异常';
  return '未检测';
}

/** 创建结构化诊断工作区。 */
export function createDiagnosticsWorkspace(options = {}) {
  const documentRef = options.document || document;
  const root = element('section', { document: documentRef, className: 'workspace workspace--diagnostics', attributes: { 'aria-labelledby': 'diagnostics-title' } });
  root.append(element('h1', { document: documentRef, className: 'visually-hidden', text: '诊断', attributes: { id: 'diagnostics-title' } }));

  const diagCard = element('div', { document: documentRef, className: 'card', attributes: { style: 'margin-bottom:16px;' } });
  const titleRow = element('div', { document: documentRef, className: 'section-title', attributes: { style: 'display:flex;justify-content:space-between;align-items:center;width:100%;' } },
    element('span', { document: documentRef, text: '系统自检' }));
  const refreshButton = element('button', { document: documentRef, className: 'btn btn-primary', text: '▶ 运行全部诊断', attributes: { type: 'button', id: 'run-diag-btn' } });
  const exportButton = element('button', { document: documentRef, className: 'btn', text: '↓ 导出报告', attributes: { type: 'button', id: 'export-diag-btn' } });
  const btnGroup = element('div', { document: documentRef, attributes: { style: 'display:flex;gap:8px;' } }, refreshButton, exportButton);
  titleRow.append(btnGroup);
  diagCard.append(titleRow, element('div', { document: documentRef, className: 'section-sub', text: '依次检测飞书连接、OpenCode 健康、Hook 端点与租约状态' }));
  const diagList = element('div', { document: documentRef, attributes: { id: 'diag-list' } });
  const errorBox = element('div', { document: documentRef, className: 'note-box', attributes: { hidden: '' } });
  diagCard.append(diagList, errorBox);
  root.append(diagCard);

  const issueCard = element('div', { document: documentRef, className: 'card' });
  issueCard.append(element('div', { document: documentRef, className: 'section-title', text: '异常会话检测' }));
  const issueList = element('div', { document: documentRef, className: 'issue-list' });
  issueCard.append(issueList);
  const historyCard = element('div', { document: documentRef, className: 'card' });
  historyCard.append(element('div', { document: documentRef, className: 'section-title', text: '诊断历史' }));
  historyCard.append(element('p', { document: documentRef, className: 'muted', text: '暂无历史记录（诊断历史未由后端持久化）' }));
  root.append(element('div', { document: documentRef, className: 'grid grid-2' }, issueCard, historyCard));

  const cleanups = [];
  let report = null;
  let active = true;
  let actionRequest = null;
  let diagState = 'idle';

  function renderDiagList() {
    diagList.replaceChildren();
    const checks = report?.checks || [];
    for (const check of checks) {
      const color = STATUS_COLOR[check.status] || 'gray';
      const item = element('div', { document: documentRef, className: 'diag-item', dataset: { status: check.status || 'unknown' } });
      const left = element('div', { document: documentRef, className: 'diag-left' },
        element('span', { document: documentRef, text: (diagState === 'done' && (check.status === 'fail' || check.status === 'warn' || check.status === 'warning')) ? '⚠' : '●', attributes: { style: `font-size:16px;color:var(--${color});` } }),
        element('div', { document: documentRef },
          element('div', { document: documentRef, className: 'diag-name', text: check.name || '检查' }),
          element('div', { document: documentRef, className: 'diag-detail', text: `${check.reason || check.detail || '—'}${check.suggestion ? '　建议：' + check.suggestion : ''}` })));
      item.append(left);
      if (diagState === 'idle') {
        item.append(element('span', { document: documentRef, className: 'badge badge-gray', text: '未检测' }));
      } else if (diagState === 'running') {
        item.append(element('div', { document: documentRef, className: 'spin' }));
      } else {
        item.append(element('span', { document: documentRef, className: `badge ${badgeClass(check.status)}`, text: badgeText(check.status, check.reason) }));
      }
      diagList.append(item);
    }
  }

  function renderIssues() {
    issueList.replaceChildren();
    const issues = (report?.checks || []).filter(check => check.status === 'fail' || check.status === 'warn' || check.status === 'warning');
    if (issues.length === 0) {
      issueList.append(element('p', { document: documentRef, className: 'muted', text: '暂无异常' }));
      return;
    }
    for (const check of issues) {
      const color = STATUS_COLOR[check.status] || 'gray';
      const row = element('div', { document: documentRef, className: 'issue-row' },
        element('div', { document: documentRef, className: 'issue-left' },
          element('span', { document: documentRef, text: '⚠', attributes: { style: `color:var(--${color});font-size:16px;` } }),
          element('div', { document: documentRef },
            element('div', { document: documentRef, style: 'font-weight:600;', text: `${check.name || '检查'} ${check.status === 'fail' ? '异常' : '警告'}` }),
            element('div', { document: documentRef, className: 'diag-detail', text: check.reason || check.detail || '—' }))));
      if (check.action?.path) {
        const actionBtn = element('button', { document: documentRef, className: 'btn btn-sm', text: check.action.label || '执行恢复', attributes: { type: 'button' } });
        cleanups.push(listen(actionBtn, 'click', () => runAction(check, actionBtn)));
        row.append(actionBtn);
      }
      issueList.append(row);
    }
  }

  function renderDone() {
    renderDiagList();
    renderIssues();
    refreshButton.disabled = false;
    refreshButton.textContent = '▶ 运行全部诊断';
  }

  async function refresh() {
    errorBox.textContent = '';
    errorBox.hidden = true;
    refreshButton.disabled = true;
    refreshButton.textContent = '检测中…';
    diagState = 'running';
    renderDiagList();
    try {
      const payload = responseData(await options.api.get('/api/admin/health', { signal: options.signal }));
      report = { checkedAt: payload.checkedAt || new Date().toISOString(), overall: payload.overall || 'unknown', checks: payload.checks || [] };
      diagState = 'done';
      options.commit ? options.commit(() => active && renderDone()) : active && renderDone();
      return report;
    } catch (error) {
      diagState = 'idle';
      refreshButton.disabled = false;
      refreshButton.textContent = '▶ 运行全部诊断';
      renderDiagList();
      if (error?.code !== 'ABORTED') {
        errorBox.textContent = error.message || String(error);
        errorBox.hidden = false;
      }
      throw error;
    }
  }

  async function runAction(check, control) {
    const action = check?.action;
    if (!action?.path || actionRequest) return actionRequest;
    if (control) setBusy(control, true, '执行中');
    actionRequest = (async () => {
      try {
        await options.api.request(action.method || 'POST', action.path, { body: action.body, signal: options.signal });
        if (!active) return null;
        return await refresh();
      } catch (error) {
        if (active && error?.code !== 'ABORTED') {
          errorBox.textContent = error.message || String(error);
          errorBox.hidden = false;
        }
        return null;
      } finally {
        actionRequest = null;
        if (active && control) setBusy(control, false);
      }
    })();
    return actionRequest;
  }

  function exportReport() {
    if (!report) return;
    (options.download || ((name, data) => defaultDownload(documentRef, name, data)))('walker-diagnostics.json', JSON.stringify(report, null, 2));
  }

  cleanups.push(listen(refreshButton, 'click', () => refresh().catch(() => undefined)));
  cleanups.push(listen(exportButton, 'click', () => exportReport()));
  function cleanup() { active = false; for (const dispose of cleanups) dispose(); }
  return { element: root, refresh, runAction, exportReport, getReport: () => report, cleanup };
}

export async function mount(context) {
  const workspace = createDiagnosticsWorkspace({ ...context, document: context.root.ownerDocument || document });
  context.commit(() => replace(context.root, workspace.element));
  const offRefresh = listen(context.root, 'walker:refresh', () => workspace.refresh());
  await workspace.refresh();
  return () => { offRefresh(); workspace.cleanup(); };
}
