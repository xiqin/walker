import { element, listen, replace, setBusy } from '../dom.js';
import { createTabs } from '../components/tabs.js';
import { createToast } from '../components/feedback.js';

const CONFIG_TABS = [
  { id: 'cfg-feishu', label: '飞书凭据', groups: ['feishu'], hint: '飞书后台需：自建应用 + 已开启机器人能力 + 长连接接收事件 + 订阅 im.message.receive_v1 + 单聊/群聊消息读取权限，并发布版本后生效。' },
  { id: 'cfg-agent', label: 'Agent 与 Runtime', groups: ['walker', 'runtime'] },
  { id: 'cfg-opencode', label: 'OpenCode 连接', groups: ['opencode'] },
  { id: 'cfg-heartbeat', label: '心跳与长任务', groups: ['timeout-recovery'] },
  { id: 'cfg-security', label: 'Hook 与安全', groups: ['admin'], hint: 'Hook 端点 POST /opencode/hook/session-created 仅接受本机 loopback 请求（127.0.0.1 / ::1 / ::ffff:127.0.0.1），非本机请求返回 403。Plugin 文件内置 Admin Token 鉴权，Walker 地址硬编码为 127.0.0.1:<port>。' },
];

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

/** 创建五标签安全配置编辑工作区。 */
export function createConfigWorkspace(options = {}) {
  const documentRef = options.document || document;
  const root = element('section', { document: documentRef, className: 'workspace workspace--config', attributes: { 'aria-labelledby': 'config-title' } });
  const heading = element('h1', { document: documentRef, className: 'visually-hidden', text: '配置', attributes: { id: 'config-title' } });
  const note = element('div', { document: documentRef, className: 'note-box', text: '以下字段与 .env 中的环境变量一一对应，保存后需重启 Walker 生效。' });

  const toast = createToast({ document: documentRef });

  const searchBox = element('div', { document: documentRef, className: 'config-search', attributes: { style: 'margin-bottom:16px;' } });
  const searchInput = element('input', {
    document: documentRef,
    className: 'search-input',
    attributes: {
      type: 'text',
      placeholder: '搜索配置项（标签、环境变量名）...',
      'aria-label': '搜索配置项',
      style: 'width:100%;',
    },
  });
  searchBox.append(searchInput);

  const form = element('form', { document: documentRef, attributes: { 'aria-label': 'Walker 配置' } });
  const errorBox = element('div', { document: documentRef, className: 'note-box error-box', attributes: { hidden: '', style: 'background:#fde8e8;color:#dc2626;border-color:#f3c6c6;' } });
  root.append(heading, note, searchBox, form, errorBox, toast.element);

  let summary = options.summary || null;
  let values = {};
  let originalValues = {};
  let inputs = new Map();
  let errorElements = new Map();
  let active = true;
  const cleanups = [];
  let tabs = null;
  let searchQuery = '';

  function fieldRow(item) {
    if (item.display === 'switch') {
      return switchRow(item);
    }
    const row = element('div', { document: documentRef, className: 'field config-field', dataset: { env: item.env, label: (item.label || '').toLowerCase(), envLower: (item.env || '').toLowerCase() } });
    const labelText = `${item.label} `;
    const labelEl = element('label', { document: documentRef },
      element('span', { document: documentRef, text: labelText }), element('span', { document: documentRef, className: 'envkey', text: item.env }));

    const errorEl = element('div', { document: documentRef, className: 'field-error', attributes: { style: 'color:#dc2626;font-size:12px;margin-top:4px;display:none;' } });

    if (item.secret) {
      const statusEl = element('span', {
        document: documentRef,
        className: item.configured ? 'badge badge-green' : 'badge badge-gray',
        text: item.configured ? '已配置' : '未配置',
        attributes: { style: 'margin-left:8px;' },
      });
      row.append(labelEl, statusEl);
    } else if (item.editable) {
      const input = item.input?.type === 'enum'
        ? element('select', { document: documentRef, className: 'select', attributes: { name: item.env, 'aria-label': item.label } })
        : element('input', { document: documentRef, className: 'config-input', attributes: { name: item.env, 'aria-label': item.label, type: item.input?.type === 'number' ? 'number' : 'text', placeholder: item.input?.placeholder || '' } });
      if (item.input?.values) for (const choice of item.input.values) {
        const displayText = item.input.labels?.[choice] || choice;
        const option = element('option', { document: documentRef, text: displayText, attributes: { value: choice } });
        option.value = choice; input.append(option);
      }
      input.value = values[item.env] ?? item.value ?? '';
      inputs.set(item.env, input);
      cleanups.push(listen(input, 'input', () => {
        values[item.env] = input.value;
        clearFieldError(item.env);
      }));
      cleanups.push(listen(input, 'change', () => {
        values[item.env] = input.value;
        clearFieldError(item.env);
      }));
      row.append(labelEl, input, errorEl);
      errorElements.set(item.env, errorEl);
    } else {
      row.append(labelEl, element('span', { document: documentRef, text: item.value ?? '' }));
    }
    if (item.hint) {
      row.append(element('div', { document: documentRef, className: 'hint', text: item.hint }));
    }
    return row;
  }

  function switchRow(item) {
    const row = element('div', { document: documentRef, className: 'switch-row config-field', dataset: { env: item.env, label: (item.label || '').toLowerCase(), envLower: (item.env || '').toLowerCase() } });
    const left = element('div', { document: documentRef },
      element('div', { document: documentRef, className: 'switch-name', text: item.label }),
      element('div', { document: documentRef, className: 'switch-desc' },
        element('span', { document: documentRef, className: 'envkey', text: item.env }),
        ...(item.description ? [documentRef.createTextNode(` · ${item.description}`)] : [])));
    const isChecked = values[item.env] === 'true';
    const checkbox = element('input', { document: documentRef, attributes: { type: 'checkbox', ...(isChecked ? { checked: '' } : {}) } });
    const slider = element('span', { document: documentRef, className: 'slider' });
    const label = element('label', { document: documentRef, className: 'switch' }, checkbox, slider);
    inputs.set(item.env, { value: isChecked, element: checkbox });
    cleanups.push(listen(checkbox, 'change', () => {
      values[item.env] = checkbox.checked ? 'true' : 'false';
      inputs.set(item.env, { value: checkbox.checked, element: checkbox });
    }));
    row.append(left, label);
    return row;
  }

  function filterFields() {
    const query = searchQuery.toLowerCase().trim();
    const fields = form.querySelectorAll('.config-field');
    for (const field of fields) {
      if (!query) {
        field.style.display = '';
        continue;
      }
      const label = field.dataset.label || '';
      const env = field.dataset.envLower || '';
      const match = label.includes(query) || env.includes(query);
      field.style.display = match ? '' : 'none';
    }
  }

  function render() {
    inputs = new Map();
    errorElements = new Map();
    if (tabs) tabs.cleanup();
    const panels = [];
    for (const tab of CONFIG_TABS) {
      const panel = element('section', { document: documentRef, className: 'subpage' });
      const card = element('div', { document: documentRef, className: 'card' });
      const grid = element('div', { document: documentRef, className: 'form-grid' });
      let count = 0;
      for (const group of summary?.groups || []) {
        if (!tab.groups.includes(group.id)) continue;
        for (const item of group.items || []) { grid.append(fieldRow(item)); count++; }
      }
      if (count === 0) card.append(element('p', { document: documentRef, className: 'muted', text: '该分组未通过 API 暴露可编辑项，请在 .env 中配置。' }));
      card.append(grid);
      if (tab.hint) card.append(element('div', { document: documentRef, className: 'hint', attributes: { style: 'margin-bottom:12px;' }, text: tab.hint }));

      const buttonGroup = element('div', { document: documentRef, attributes: { style: 'display:flex;gap:8px;margin-top:14px;' } });
      const resetButton = element('button', { document: documentRef, className: 'btn', text: '重置为默认值', attributes: { type: 'button' } });
      const saveButton = element('button', { document: documentRef, className: 'btn btn-primary', text: '保存更改', attributes: { type: 'submit' } });
      buttonGroup.append(resetButton, saveButton);

      cleanups.push(listen(resetButton, 'click', () => {
        if (!confirm('确定要重置当前分组的所有配置为默认值吗？')) return;
        resetTabDefaults(tab.groups);
        toast.show('已重置为默认值（未保存）', 'neutral', 3000);
      }));

      card.append(buttonGroup);
      panel.append(card);
      panels.push({ id: tab.id, label: tab.label, panel });
    }
    tabs = createTabs({ document: documentRef, label: '配置分组', tabs: panels });
    form.replaceChildren(tabs.element, ...panels.map(p => p.panel));
    filterFields();
  }

  function resetTabDefaults(groupIds) {
    for (const group of summary?.groups || []) {
      if (!groupIds.includes(group.id)) continue;
      for (const item of group.items || []) {
        if (!item.editable || item.secret) continue;
        const defaultValue = item.defaultValue ?? '';
        values[item.env] = defaultValue;
        const input = inputs.get(item.env);
        if (input) {
          if (input.element) {
            input.value = defaultValue === 'true';
            input.element.checked = defaultValue === 'true';
          } else {
            input.value = defaultValue;
          }
        }
      }
    }
  }

  function applySummary(nextSummary) {
    summary = nextSummary || { groups: [], editableKeys: [] };
    values = {};
    for (const group of summary.groups || []) for (const item of group.items || []) if (!item.secret && item.editable) values[item.env] = item.value ?? '';
    originalValues = { ...values };
    render();
  }

  async function load() {
    hideError();
    try {
      applySummary(responseData(await options.api.get('/api/admin/config', { signal: options.signal })));
      return summary;
    } catch (error) {
      if (error?.code !== 'ABORTED') showError(error.message || '加载配置失败');
      throw error;
    }
  }

  function setValue(key, value) {
    values[key] = String(value ?? '');
    const entry = inputs.get(key);
    if (entry) {
      if (entry.element) {
        entry.value = value === 'true';
        entry.element.checked = value === 'true';
      } else {
        entry.value = values[key];
      }
    }
  }

  function showFieldError(env, message) {
    const errorEl = errorElements.get(env);
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = 'block';
    }
    const field = form.querySelector(`[data-env="${env}"]`);
    if (field) {
      const input = field.querySelector('input, select');
      if (input) input.style.borderColor = '#dc2626';
    }
  }

  function clearFieldError(env) {
    const errorEl = errorElements.get(env);
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    }
    const field = form.querySelector(`[data-env="${env}"]`);
    if (field) {
      const input = field.querySelector('input, select');
      if (input) input.style.borderColor = '';
    }
  }

  function clearAllErrors() {
    for (const [env] of errorElements) clearFieldError(env);
  }

  function validate() {
    const errors = {};
    clearAllErrors();
    for (const group of summary?.groups || []) for (const item of group.items || []) {
      if (!item.editable || item.secret || !item.input) continue;
      const message = validationMessage(values[item.env], item.input);
      if (message) {
        errors[item.env] = message;
        showFieldError(item.env, message);
      }
    }
    return errors;
  }

  function showError(message) {
    errorBox.removeAttribute('hidden');
    errorBox.textContent = message;
  }
  function hideError() {
    errorBox.setAttribute('hidden', '');
    errorBox.textContent = '';
    clearAllErrors();
  }

  async function save() {
    const errors = validate();
    if (Object.keys(errors).length) {
      const firstErrorEnv = Object.keys(errors)[0];
      const firstErrorField = form.querySelector(`[data-env="${firstErrorEnv}"]`);
      if (firstErrorField) firstErrorField.scrollIntoView({ behavior: 'smooth', block: 'center' });
      showError(`请修正 ${Object.keys(errors).length} 个配置错误`);
      throw new Error('请修正配置校验错误');
    }
    const allowed = new Set(summary?.editableKeys || []);
    const body = Object.fromEntries(Object.entries(values).filter(([key]) => allowed.has(key)));
    const saveButton = form.querySelector ? form.querySelector('button[type=submit]') : null;
    if (saveButton) setBusy(saveButton, true, '保存中');
    try {
      const result = responseData(await options.api.patch('/api/admin/config', body, { signal: options.signal }));
      originalValues = { ...values };
      hideError();
      toast.show('配置已保存，重启 Walker 后生效', 'success', 4000);
      return result;
    } catch (error) {
      values = { ...originalValues };
      render();
      showError(error.message || '保存失败');
      throw error;
    } finally {
      if (saveButton) setBusy(saveButton, false);
    }
  }

  cleanups.push(listen(form, 'submit', event => { event.preventDefault(); save().catch(() => undefined); }));
  cleanups.push(listen(searchInput, 'input', () => { searchQuery = searchInput.value; filterFields(); }));

  if (summary) applySummary(summary);
  function cleanup() { active = false; if (tabs) tabs.cleanup(); for (const dispose of cleanups) dispose(); }
  return { element: root, load, save, validate, setValue, getValue: key => values[key], getGroups: () => summary?.groups || [], cleanup, get active() { return active; } };
}

export async function mount(context) {
  const workspace = createConfigWorkspace({ ...context, document: context.root.ownerDocument || document });
  context.commit(() => replace(context.root, workspace.element));
  const offRefresh = listen(context.root, 'walker:refresh', () => workspace.load().catch(() => undefined));
  await workspace.load();
  return () => { offRefresh(); workspace.cleanup(); };
}
