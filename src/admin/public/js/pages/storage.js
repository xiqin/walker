import { element, listen, replace } from '../dom.js';
import { createConfirm, createFeedback } from '../components/feedback.js';

function encodePath(value) {
  return encodeURIComponent(String(value));
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return '未知';
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / (1024 * 1024)).toFixed(1) + ' MB';
}

/** 创建存储与维护工作区。 */
export function createStorageWorkspace(options = {}) {
  const documentRef = options.document || document;
  const root = element('section', { document: documentRef, className: 'workspace workspace--storage', attributes: { 'aria-labelledby': 'storage-title' } });
  root.append(element('h1', { document: documentRef, className: 'visually-hidden', text: '存储与维护', attributes: { id: 'storage-title' } }));
  root.append(element('div', { document: documentRef, className: 'note-box', text: '数据存储在 .walker/ 目录：state.json（session/route 信息）、attachments/（入站附件）。' }));
  const feedback = createFeedback({ document: documentRef });
  const confirmComponent = options.confirm ? null : createConfirm({ document: documentRef, title: '确认维护操作' });
  const ask = options.confirm || (message => confirmComponent.ask(message));
  const cleanups = [];
  let active = true;

  const diskBody = element('div', { document: documentRef });
  const diskCard = element('div', { document: documentRef, className: 'card' },
    element('div', { document: documentRef, className: 'section-title', text: '磁盘占用' }), diskBody,
    element('div', { document: documentRef, className: 'hint', text: '详细分目录占用未由后端暴露，仅显示附件聚合。' }));

  const actionButtons = element('div', { document: documentRef, attributes: { style: 'display:flex;flex-direction:column;gap:10px;' } });
  const actionCard = element('div', { document: documentRef, className: 'card' },
    element('div', { document: documentRef, className: 'section-title', text: '维护操作' }), actionButtons);
  root.append(element('div', { document: documentRef, className: 'grid grid-2-1' }, diskCard, actionCard));

  const attachmentCard = element('div', { document: documentRef, className: 'card' },
    element('div', { document: documentRef, className: 'section-title', text: '附件' }));
  const attachmentList = element('section', { document: documentRef, className: 'attachment-list', attributes: { 'aria-label': '附件列表' } });
  attachmentCard.append(attachmentList);
  root.append(attachmentCard);

  const deletedCard = element('div', { document: documentRef, className: 'card' },
    element('div', { document: documentRef, className: 'section-title', text: '已删除但未清理的 Session' }),
    element('p', { document: documentRef, className: 'muted', text: '暂无已删除未清理的 Session（后端未暴露该列表）' }));
  root.append(deletedCard);

  root.append(feedback.element);
  if (confirmComponent) root.append(confirmComponent.element);

  const cleanupBtn = element('button', { document: documentRef, className: 'btn', text: '清理过期附件', attributes: { type: 'button' } });
  const backupBtn = element('button', { document: documentRef, className: 'btn', text: '备份 session/route 数据', attributes: { type: 'button' } });
  const exportLogsBtn = element('button', { document: documentRef, className: 'btn', text: '导出日志', attributes: { type: 'button' } });
  const restoreBtn = element('button', { document: documentRef, className: 'btn', text: '从备份恢复', attributes: { type: 'button' } });
  const resetBtn = element('button', { document: documentRef, className: 'btn btn-danger', text: '清空 .walker 数据目录', attributes: { type: 'button' } });
  actionButtons.append(cleanupBtn, backupBtn, exportLogsBtn, restoreBtn, resetBtn);

  async function request(method, url, body) {
    return options.api.request(method, url, { ...(body === undefined ? {} : { body }), signal: options.signal });
  }

  async function loadAttachments() {
    feedback.showLoading('正在加载附件');
    try {
      const response = await options.api.get('/api/admin/attachments', { signal: options.signal });
      const attachments = response?.data ?? response ?? [];
      const count = attachments.totalFiles ?? (Array.isArray(attachments) ? attachments.length : 0);
      const totalBytes = (attachments.groups || []).reduce((sum, group) => sum + (group.files || []).reduce((s, file) => s + Number(file.size || 0), 0), 0);
      if (!active) return attachments;
      diskBody.replaceChildren(
        element('div', { document: documentRef, attributes: { style: 'font-size:26px;font-weight:700;' }, text: `${count} 个附件` }),
        element('div', { document: documentRef, attributes: { style: 'font-size:13px;color:var(--text-secondary);margin-top:4px;' }, text: `合计 ${formatBytes(totalBytes)}` }),
      );
      attachmentList.replaceChildren();
      for (const group of attachments.groups || []) {
        const groupSection = element('section', { document: documentRef, className: 'attachment-group' });
        groupSection.append(element('div', { document: documentRef, className: 'section-title', text: group.sessionId || '未知 Session', attributes: { style: 'font-size:13.5px;' } }));
        const list = element('ul', { document: documentRef });
        for (const file of group.files || []) {
          const path = `/api/admin/attachments/${encodePath(group.sessionId)}/${encodePath(file.name)}`;
          const download = element('a', { document: documentRef, text: '查看/下载', attributes: { href: path, download: file.name } });
          const remove = element('button', { document: documentRef, className: 'btn btn-sm btn-danger', text: '删除附件', attributes: { type: 'button' } });
          cleanups.push(listen(remove, 'click', () => deleteAttachment(group.sessionId, file.name).catch(error => active && feedback.showError(error))));
          list.append(element('li', { document: documentRef, attributes: { style: 'display:flex;gap:8px;align-items:center;margin-bottom:6px;' } },
            element('span', { document: documentRef, text: `${file.name} · ${file.size ?? 0} B · ${file.modifiedAt || '时间未知'}` }),
            download, remove));
        }
        groupSection.append(list);
        attachmentList.append(groupSection);
      }
      if (!count) attachmentList.append(element('p', { document: documentRef, className: 'muted', text: '暂无附件' }));
      feedback.showContent(element('p', { document: documentRef, text: '附件已加载' }));
      return attachments;
    } catch (error) {
      if (error?.code !== 'ABORTED') feedback.showError(error, loadAttachments);
      throw error;
    }
  }

  async function deleteAttachment(sessionId, filename) {
    const confirmed = await ask(`删除附件 ${sessionId}/${filename}？目标文件将永久删除且不可恢复。`);
    if (!confirmed) return false;
    await request('DELETE', `/api/admin/attachments/${encodePath(sessionId)}/${encodePath(filename)}`);
    if (active) await loadAttachments();
    return true;
  }

  async function createBackup() {
    await request('POST', '/api/admin/backup', {});
    feedback.showContent(element('p', { document: documentRef, text: '备份已创建' }));
  }

  async function cleanupAll() {
    const confirmed = await ask('批量清理悬空 Route 引用和孤立附件？这些绑定与文件将被删除，操作不可恢复。');
    if (!confirmed) return false;
    await request('POST', '/api/admin/cleanup', { confirmed: true });
    return true;
  }

  async function stopService() {
    const confirmed = await ask('停止 Walker 服务？管理控制台连接中断，飞书和 OpenCode 连接也会立即关闭，需要手动重新启动进程。');
    if (!confirmed) return false;
    await request('POST', '/api/admin/service/stop', { confirm: true });
    return true;
  }

  cleanups.push(listen(cleanupBtn, 'click', () => cleanupAll().catch(error => feedback.showError(error))));
  cleanups.push(listen(backupBtn, 'click', () => createBackup().catch(error => feedback.showError(error))));
  cleanups.push(listen(exportLogsBtn, 'click', () => { (options.download || downloadLogs)(options); }));
  cleanups.push(listen(restoreBtn, 'click', () => feedback.showContent(element('p', { document: documentRef, text: '备份恢复请手动替换 .walker 目录（后端未暴露该接口）' }))));
  cleanups.push(listen(resetBtn, 'click', async () => {
    const confirmed = await ask('清空 .walker 数据目录将删除 state.json 与 attachments/，此操作不可撤销且后端无对应接口，确认继续？');
    if (confirmed) feedback.showContent(element('p', { document: documentRef, text: '已记录请求；请手动停止 Walker 并清空 .walker 目录' }));
  }));

  function cleanup() { active = false; confirmComponent?.cleanup(); for (const dispose of cleanups) dispose(); }
  return { element: root, loadAttachments, deleteAttachment, createBackup, cleanupAll, stopService, cleanup };
}

function downloadLogs(options) {
  const link = element('a', { document: options.document || document, attributes: { href: '/api/admin/logs?lines=500', download: 'walker.log' } });
  link.click();
}

export async function mount(context) {
  const workspace = createStorageWorkspace({ ...context, document: context.root.ownerDocument || document });
  context.commit(() => replace(context.root, workspace.element));
  const offRefresh = listen(context.root, 'walker:refresh', () => workspace.loadAttachments().catch(() => undefined));
  await workspace.loadAttachments();
  return () => { offRefresh(); workspace.cleanup(); };
}
