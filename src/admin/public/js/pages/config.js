import { element, listen, replace, setBusy } from '../dom.js';
import { createFeedback } from '../components/feedback.js';

function responseData(response) {
  return response?.data ?? response ?? {};
}

function validationMessage(value, input = {}) {
  const text = input.trim ? String(value).trim() : String(value ?? '');
  if (input.required && !text) return '不能为空';
  if (input.minLength != null && text.length < input.minLength) return `长度不能小于 ${input.minLength}`;
  if (input.values && !input.values.includes(text)) return `必须为 ${input.values.join('、')} 之一`;
  if (input.type === 'number') {
    const number = Number(text);
    if (!Number.isFinite(number)) return '必须为数字';
    if (input.integer && !Number.isInteger(number)) return '必须为整数';
    if (input.min != null && number < input.min) return `必须大于等于 ${input.min}`;
    if (input.max != null && number > input.max) return `必须小于等于 ${input.max}`;
  }
  if (input.pattern && text && !new RegExp(input.pattern).test(text)) return '格式不正确';
  if (input.type === 'url' && text) {
    try {
      const protocol = new URL(text).protocol;
      if (input.protocols && !input.protocols.includes(protocol)) return `协议必须为 ${input.protocols.join('、')}`;
    } catch {
      return '必须为有效 URL';
    }
  }
  return '';
}

/** 创建八组安全配置编辑工作区。 */
export function createConfigWorkspace(options = {}) {
  const documentRef = options.document || document;
  const root = element('section', { document: documentRef, className: 'workspace workspace--config', attributes: { 'aria-labelledby': 'config-title' } });
  const heading = element('h1', { document: documentRef, text: '配置', attributes: { id: 'config-title' } });
  const form = element('form', { document: documentRef, attributes: { 'aria-label': 'Walker 配置' } });
  const saveButton = element('button', { document: documentRef, text: '保存配置', attributes: { type: 'submit' } });
  const feedback = createFeedback({ document: documentRef });
  root.append(heading, feedback.element, form);
  let summary = options.summary || null;
  let values = {};
  let originalValues = {};
  let inputs = new Map();
  let active = true;
  const cleanups = [];

  function render() {
    inputs = new Map();
    const groups = [];
    for (const group of summary?.groups || []) {
      const fieldset = element('fieldset', { document: documentRef, className: 'config-group', attributes: { 'data-group': group.id } });
      fieldset.append(element('legend', { document: documentRef, text: group.label }));
      for (const item of group.items || []) {
        const row = element('div', { document: documentRef, className: 'config-field' });
        row.append(element('strong', { document: documentRef, text: `${item.label} (${item.env})` }));
        if (item.secret) {
          row.append(element('span', { document: documentRef, text: item.configured ? '已配置' : '未配置' }));
        } else if (item.editable) {
          const input = item.input?.type === 'enum'
            ? element('select', { document: documentRef, attributes: { name: item.env, 'aria-label': item.label } })
            : element('input', { document: documentRef, attributes: { name: item.env, 'aria-label': item.label, type: item.input?.type === 'number' ? 'number' : 'text' } });
          if (item.input?.values) for (const choice of item.input.values) input.append(element('option', { document: documentRef, text: choice, attributes: { value: choice } }));
          input.value = values[item.env] ?? item.value ?? '';
          inputs.set(item.env, input);
          cleanups.push(listen(input, 'input', () => { values[item.env] = input.value; }));
          cleanups.push(listen(input, 'change', () => { values[item.env] = input.value; }));
          row.append(input);
        } else {
          row.append(element('span', { document: documentRef, text: item.value ?? '' }));
        }
        row.append(element('small', { document: documentRef, text: `默认：${item.secret ? '不显示' : item.defaultValue ?? '无'} · 来源：${item.source || '未知'} · ${item.restartRequired ? '保存后需重启' : '立即生效'}` }));
        fieldset.append(row);
      }
      groups.push(fieldset);
    }
    form.replaceChildren(...groups, saveButton);
  }

  function applySummary(nextSummary) {
    summary = nextSummary || { groups: [], editableKeys: [] };
    values = {};
    for (const group of summary.groups || []) for (const item of group.items || []) if (!item.secret && item.editable) values[item.env] = item.value ?? '';
    originalValues = { ...values };
    render();
  }

  async function load() {
    feedback.showLoading('正在加载配置');
    try {
      applySummary(responseData(await options.api.get('/api/admin/config', { signal: options.signal })));
      feedback.showContent(element('p', { document: documentRef, text: '配置已加载' }));
      return summary;
    } catch (error) {
      if (error?.code !== 'ABORTED') feedback.showError(error, load);
      throw error;
    }
  }

  function setValue(key, value) {
    values[key] = String(value ?? '');
    if (inputs.has(key)) inputs.get(key).value = values[key];
  }

  function validate() {
    const errors = {};
    for (const group of summary?.groups || []) for (const item of group.items || []) {
      if (!item.editable || item.secret || !item.input) continue;
      const message = validationMessage(values[item.env], item.input);
      if (message) errors[item.env] = message;
    }
    return errors;
  }

  async function save() {
    const errors = validate();
    if (Object.keys(errors).length) {
      const error = new Error('请修正配置校验错误');
      feedback.showError(error);
      throw error;
    }
    const allowed = new Set(summary?.editableKeys || []);
    const body = Object.fromEntries(Object.entries(values).filter(([key]) => allowed.has(key)));
    setBusy(saveButton, true, '保存中');
    try {
      const result = responseData(await options.api.patch('/api/admin/config', body, { signal: options.signal }));
      originalValues = { ...values };
      const keys = result.updatedKeys || Object.keys(body);
      feedback.showContent(element('p', { document: documentRef, text: `已保存：${keys.join('、') || '无变更'} · 来源：${result.source || 'env-file'} · ${result.restartRequired ? '需要重启后生效' : '已生效'}` }));
      return result;
    } catch (error) {
      values = { ...originalValues };
      render();
      feedback.showError(error);
      throw error;
    } finally {
      setBusy(saveButton, false);
    }
  }

  cleanups.push(listen(form, 'submit', event => { event.preventDefault(); save().catch(() => undefined); }));
  if (summary) applySummary(summary);
  function cleanup() { active = false; for (const dispose of cleanups) dispose(); }
  return { element: root, load, save, validate, setValue, getValue: key => values[key], getGroups: () => summary?.groups || [], cleanup, get active() { return active; } };
}

export async function mount(context) {
  const workspace = createConfigWorkspace({ ...context, document: context.root.ownerDocument || document });
  context.commit(() => replace(context.root, workspace.element));
  await workspace.load();
  return workspace.cleanup;
}
