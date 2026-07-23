import { element, listen, replace } from '../dom.js';
import { createConfirm, createFeedback } from '../components/feedback.js';

function encodePath(value) {
  return encodeURIComponent(String(value));
}

/** 创建存储与维护工作区。 */
export function createStorageWorkspace(options = {}) {
  const documentRef = options.document || document;
  const root = element('section', { document: documentRef, className: 'workspace workspace--storage', attributes: { 'aria-labelledby': 'storage-title' } });
  const heading = element('h1', { document: documentRef, text: '存储与维护', attributes: { id: 'storage-title' } });
  const feedback = createFeedback({ document: documentRef });
  const confirmComponent = options.confirm ? null : createConfirm({ document: documentRef, title: '确认维护操作' });
  const ask = options.confirm || (message => confirmComponent.ask(message));
  const cleanups = [];
  let active = true;
  const sections = [
    ['数据文件', '查看和导出 Session 与 Route 数据。'],
    ['附件', '下载或删除指定 Session 的附件。'],
    ['备份', '创建当前 state.json 的时间戳备份。'],
    ['导出', '下载 walker-export.json。'],
    ['清理', '清理悬空 Route 引用和孤立附件。'],
    ['危险区', '停止 Walker 服务并中断所有连接。'],
  ];
  root.append(heading);
  for (const [title, description] of sections) root.append(element('section', { document: documentRef, className: title === '危险区' ? 'danger-zone' : 'maintenance-section' }, element('h2', { document: documentRef, text: title }), element('p', { document: documentRef, text: description })));
  const backupButton = element('button', { document: documentRef, text: '创建备份', attributes: { type: 'button' } });
  const exportLink = element('a', { document: documentRef, text: '导出数据', attributes: { href: '/api/admin/export', download: 'walker-export.json' } });
  const cleanupButton = element('button', { document: documentRef, text: '批量清理', attributes: { type: 'button' } });
  const stopButton = element('button', { document: documentRef, text: '停止服务', attributes: { type: 'button' } });
  root.append(element('div', { document: documentRef, className: 'toolbar' }, backupButton, exportLink, cleanupButton, stopButton), feedback.element);
  if (confirmComponent) root.append(confirmComponent.element);

  async function request(method, url, body) {
    return options.api.request(method, url, { ...(body === undefined ? {} : { body }), signal: options.signal });
  }

  async function loadAttachments() {
    feedback.showLoading('正在加载附件');
    try {
      const response = await options.api.get('/api/admin/attachments', { signal: options.signal });
      const attachments = response?.data ?? response ?? [];
      const count = attachments.totalFiles ?? (Array.isArray(attachments) ? attachments.length : 0);
      if (!active) return attachments;
      const content = element('section', { document: documentRef, className: 'attachment-list', attributes: { 'aria-label': '附件列表' } });
      content.append(element('p', { document: documentRef, text: `附件对象：${count}` }));
      for (const group of attachments.groups || []) {
        const groupSection = element('section', { document: documentRef, className: 'attachment-group' });
        groupSection.append(element('h3', { document: documentRef, text: group.sessionId || '未知 Session' }));
        const list = element('ul', { document: documentRef });
        for (const file of group.files || []) {
          const path = `/api/admin/attachments/${encodePath(group.sessionId)}/${encodePath(file.name)}`;
          const download = element('a', { document: documentRef, text: '查看/下载', attributes: { href: path, download: file.name } });
          const remove = element('button', { document: documentRef, text: '删除附件', attributes: { type: 'button' } });
          cleanups.push(listen(remove, 'click', () => deleteAttachment(group.sessionId, file.name).catch(error => active && feedback.showError(error))));
          list.append(element('li', { document: documentRef }, element('span', { document: documentRef, text: `${file.name} · ${file.size ?? 0} bytes · ${file.modifiedAt || '时间未知'}` }), download, remove));
        }
        groupSection.append(list);
        content.append(groupSection);
      }
      if (!count) content.append(element('p', { document: documentRef, text: '暂无附件' }));
      feedback.showContent(content);
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

  cleanups.push(listen(backupButton, 'click', () => createBackup().catch(error => feedback.showError(error))));
  cleanups.push(listen(cleanupButton, 'click', () => cleanupAll().catch(error => feedback.showError(error))));
  cleanups.push(listen(stopButton, 'click', () => stopService().catch(error => feedback.showError(error))));
  function cleanup() { active = false; confirmComponent?.cleanup(); for (const dispose of cleanups) dispose(); }
  return { element: root, loadAttachments, deleteAttachment, createBackup, cleanupAll, stopService, cleanup };
}

export async function mount(context) {
  const workspace = createStorageWorkspace({ ...context, document: context.root.ownerDocument || document });
  context.commit(() => replace(context.root, workspace.element));
  await workspace.loadAttachments();
  return workspace.cleanup;
}
