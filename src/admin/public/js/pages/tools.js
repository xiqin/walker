import { element, listen, replace } from '../dom.js';
import { createConfirm, createFeedback } from '../components/feedback.js';

export const PREVIEW_CATEGORIES = Object.freeze(['session', 'attachable', 'model', 'progress', 'permission', 'question', 'error', 'help']);

const API_CARD_TYPES = Object.freeze({
  session: 'session_list',
  attachable: 'attachable_session',
  model: 'model',
  progress: 'progress',
  permission: 'permission',
  question: 'question_confirm',
  error: 'error',
  help: 'help',
});

function responseData(response) {
  return response?.data ?? response ?? {};
}

const SAFE_ENUM_KEYS = new Set(['type', 'typeName', 'template', 'format', 'style', 'status', 'phase', 'action']);

function safeEnum(value) {
  return /^[a-z][a-z0-9_-]{0,47}$/i.test(value) ? value : '[REDACTED]';
}

function sanitizeStructure(value, key = '') {
  if (typeof value === 'string') return SAFE_ENUM_KEYS.has(key) ? safeEnum(value) : '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => sanitizeStructure(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitizeStructure(item, name)]));
  return value;
}

function safeJson(value) {
  return JSON.stringify(sanitizeStructure(value), null, 2);
}

/** 创建命令模拟、原始 JSON 和卡片预览工作区。 */
export function createToolsWorkspace(options = {}) {
  const documentRef = options.document || document;
  const root = element('section', { document: documentRef, className: 'workspace workspace--tools', attributes: { 'aria-labelledby': 'tools-title' } });
  const heading = element('h1', { document: documentRef, text: '调试工具', attributes: { id: 'tools-title' } });
  const commandInput = element('textarea', { document: documentRef, attributes: { 'aria-label': '命令或消息', rows: '4' } });
  const dryRun = element('input', { document: documentRef, attributes: { type: 'checkbox', 'aria-label': '仅 dry-run 模拟' } });
  dryRun.checked = true;
  const simulateButton = element('button', { document: documentRef, text: '模拟命令', attributes: { type: 'button' } });
  const rawJson = element('pre', { document: documentRef, className: 'raw-json', attributes: { tabindex: '0', 'aria-label': '原始 JSON' } });
  const preview = element('section', { document: documentRef, className: 'card-preview', attributes: { 'aria-live': 'polite' } });
  const categories = element('ul', { document: documentRef, className: 'preview-categories', attributes: { 'aria-label': '卡片预览类型' } });
  const feedback = createFeedback({ document: documentRef });
  const confirmComponent = options.confirm ? null : createConfirm({ document: documentRef, title: '确认请求预演' });
  const ask = options.confirm || (message => confirmComponent.ask(message));
  const cleanups = [];
  root.append(heading, element('label', { document: documentRef, text: '命令模拟' }, commandInput), element('label', { document: documentRef, text: '默认 dry-run' }, dryRun), simulateButton, element('h2', { document: documentRef, text: '八类卡片预览' }), categories, preview, element('h2', { document: documentRef, text: '原始 JSON' }), rawJson, feedback.element);
  if (confirmComponent) root.append(confirmComponent.element);

  function renderServerPreview(data) {
    const card = element('article', { document: documentRef, className: 'preview-card' });
    const items = Array.isArray(data?.elements) ? data.elements : [];
    const count = Number.isFinite(data?.elementCount) ? data.elementCount : items.length;
    card.append(element('h3', { document: documentRef, text: '服务端卡片预览' }));
    card.append(element('p', { document: documentRef, text: `元素数量：${count}` }));
    for (const item of items) {
      const type = typeof item?.type === 'string' ? safeEnum(item.type) : 'unknown';
      const actionCount = Array.isArray(item?.actions) ? item.actions.length : 0;
      card.append(element('p', { document: documentRef, text: `类型：${type}${actionCount ? ` · 操作数量：${actionCount}` : ''}` }));
    }
    preview.replaceChildren(card);
  }

  async function simulate(text = commandInput.value, settings = {}) {
    const useDryRun = settings.dryRun === undefined ? dryRun.checked : Boolean(settings.dryRun);
    if (!useDryRun) {
      const confirmed = await ask(`发起“${text}”的非 dry-run 模拟请求？这是请求预演模式，只改变模拟参数，不会真实发送或执行命令。`);
      if (!confirmed) return null;
    }
    const params = new URLSearchParams({ text, dryRun: String(useDryRun) });
    if (settings.routeKey) params.set('routeKey', settings.routeKey);
    const payload = responseData(await options.api.get('/api/admin/tools/command-simulate?' + params, { signal: options.signal }));
    const safePayload = sanitizeStructure(payload);
    rawJson.textContent = JSON.stringify(safePayload, null, 2);
    feedback.showContent(element('p', { document: documentRef, text: useDryRun ? 'dry-run 模拟完成，未产生外部副作用' : '非 dry-run 模拟请求已完成，仅为请求预演，未真实执行' }));
    return safePayload;
  }

  async function previewCard(category, data) {
    const type = API_CARD_TYPES[category] || category;
    const payload = responseData(await options.api.post('/api/admin/tools/cards/preview', { type, ...(data === undefined ? {} : { data }) }, { signal: options.signal }));
    rawJson.textContent = safeJson(payload);
    renderServerPreview(payload.preview || payload.rendered || payload);
    return sanitizeStructure(payload);
  }

  for (const category of PREVIEW_CATEGORIES) {
    const button = element('button', { document: documentRef, text: category, attributes: { type: 'button', 'data-preview': category } });
    cleanups.push(listen(button, 'click', () => previewCard(category).catch(error => feedback.showError(error))));
    categories.append(element('li', { document: documentRef }, button));
  }
  cleanups.push(listen(simulateButton, 'click', () => simulate().catch(error => feedback.showError(error))));
  function cleanup() { confirmComponent?.cleanup(); for (const dispose of cleanups) dispose(); }
  return { element: root, rawJson, simulate, previewCard, cleanup };
}

export function mount(context) {
  const workspace = createToolsWorkspace({ ...context, document: context.root.ownerDocument || document });
  context.commit(() => replace(context.root, workspace.element));
  return workspace.cleanup;
}
