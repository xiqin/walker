import { element, listen, replace, setBusy } from '../dom.js';
import { createFeedback } from '../components/feedback.js';

function responseData(response) {
  return response?.data ?? response ?? {};
}

function defaultDownload(documentRef, name, data) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const link = element('a', { document: documentRef, attributes: { href: url, download: name } });
  link.click();
  URL.revokeObjectURL(url);
}

/** 创建结构化诊断工作区。 */
export function createDiagnosticsWorkspace(options = {}) {
  const documentRef = options.document || document;
  const root = element('section', { document: documentRef, className: 'workspace workspace--diagnostics', attributes: { 'aria-labelledby': 'diagnostics-title' } });
  const heading = element('h1', { document: documentRef, text: '诊断', attributes: { id: 'diagnostics-title' } });
  const toolbar = element('div', { document: documentRef, className: 'toolbar' });
  const refreshButton = element('button', { document: documentRef, text: '重新检查', attributes: { type: 'button' } });
  const exportButton = element('button', { document: documentRef, text: '导出当前报告', attributes: { type: 'button' } });
  const feedback = createFeedback({ document: documentRef });
  const cleanups = [];
  let report = null;
  let active = true;
  let actionRequest = null;
  toolbar.append(refreshButton, exportButton);
  root.append(heading, toolbar, feedback.element);

  function renderReport() {
    const content = element('div', { document: documentRef, className: 'diagnostic-report' });
    content.append(element('p', { document: documentRef, text: `总体：${report.overall || 'unknown'} · 检查时间：${report.checkedAt || '未知'}` }));
    const groups = new Map();
    for (const check of report.checks || []) {
      const group = check.group || 'walker';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(check);
    }
    for (const [group, checks] of groups) {
      const section = element('section', { document: documentRef, className: 'diagnostic-group' });
      section.append(element('h2', { document: documentRef, text: group }));
      for (const check of checks) {
        const article = element('article', { document: documentRef, className: 'diagnostic-check', dataset: { status: check.status || 'unknown' } });
        article.append(element('h3', { document: documentRef, text: `${check.name || '检查'} · ${check.status || 'unknown'}` }));
        article.append(element('p', { document: documentRef, text: `时间：${check.checkedAt || report.checkedAt || '未知'}` }));
        if (check.reason || check.detail) article.append(element('p', { document: documentRef, text: `原因：${check.reason || check.detail}` }));
        if (check.suggestion) article.append(element('p', { document: documentRef, text: `建议：${check.suggestion}` }));
        if (check.action?.path) {
          const action = element('button', { document: documentRef, text: check.action.label || '执行恢复', attributes: { type: 'button' } });
          cleanups.push(listen(action, 'click', () => runAction(check, action)));
          article.append(action);
        }
        section.append(article);
      }
      content.append(section);
    }
    feedback.showContent(content);
  }

  async function refresh() {
    feedback.showLoading('正在执行诊断');
    try {
      const payload = responseData(await options.api.get('/api/admin/health', { signal: options.signal }));
      report = { checkedAt: payload.checkedAt || new Date().toISOString(), overall: payload.overall || 'unknown', checks: payload.checks || [] };
      options.commit ? options.commit(() => active && renderReport()) : active && renderReport();
      return report;
    } catch (error) {
      if (error?.code !== 'ABORTED') feedback.showError(error, refresh);
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
        if (active && error?.code !== 'ABORTED') feedback.showError(error, refresh);
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
  cleanups.push(listen(exportButton, 'click', exportReport));
  function cleanup() { active = false; for (const dispose of cleanups) dispose(); }
  return { element: root, refresh, runAction, exportReport, getReport: () => report, cleanup };
}

export async function mount(context) {
  const workspace = createDiagnosticsWorkspace({ ...context, document: context.root.ownerDocument || document });
  context.commit(() => replace(context.root, workspace.element));
  await workspace.refresh();
  return workspace.cleanup;
}
