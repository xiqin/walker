import { element, listen, replace } from '../dom.js';

const LEVELS = ['', 'INFO', 'WARN', 'ERROR', 'DEBUG'];
const SOURCES = ['', '飞书 WSClient', 'OpenCode Hook', 'TUI Bridge', 'AgentDriver', 'ProgressCard'];
const ROW_COUNTS = [80, 200, 500];

function responseData(response) {
  return response?.data ?? response ?? {};
}

function logText(line) {
  return typeof line === 'string' ? line : line.raw || line.message || JSON.stringify(line);
}

function structuredLog(line) {
  if (line && typeof line === 'object') return line;
  if (typeof line !== 'string') return null;
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function extractLogFields(line) {
  const entry = structuredLog(line);
  if (!entry) return { time: '', level: '', source: '', msg: logText(line) };
  const ts = entry.createdAt ?? entry.timestamp ?? entry.time ?? entry.ts ?? '';
  let time = '';
  if (ts) {
    try {
      const d = new Date(typeof ts === 'number' ? ts : ts);
      if (Number.isFinite(d.getTime())) time = d.toTimeString().slice(0, 8);
    } catch (_) {}
  }
  return {
    time,
    level: String(entry.level ?? entry.severity ?? '').toUpperCase(),
    source: String(entry.source ?? entry.component ?? entry.logger ?? ''),
    msg: entry.message ?? entry.msg ?? entry.raw ?? logText(line),
  };
}

function downloadText(documentRef, name, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = element('a', { document: documentRef, attributes: { href: url, download: name } });
  link.click();
  URL.revokeObjectURL(url);
}

/** 创建活动与日志页面工作区。 */
export function createLogsWorkspace(options = {}) {
  const documentRef = options.document || document;
  const api = options.api;
  const signal = options.signal;
  const isCurrent = options.isCurrent || (() => true);
  const commit = options.commit || (callback => { if (isCurrent()) callback(); });
  const intervalMs = options.intervalMs || 5000;
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;

  let query = '';
  let level = '';
  let source = '';
  let autoScroll = true;
  let rowCount = 80;
  let active = true;
  let timer = null;
  let logRequest = null;
  let rawLines = [];

  const root = element('section', { document: documentRef, className: 'workspace workspace--activity' });

  const noteBox = element('div', { document: documentRef, className: 'note-box' });
  const mono1 = element('span', { document: documentRef, className: 'mono', text: 'walker logs [N]' });
  const mono2 = element('span', { document: documentRef, className: 'mono', text: 'logs/walker.log' });
  const mono3 = element('span', { document: documentRef, className: 'mono', text: '.out.log' });
  const mono4 = element('span', { document: documentRef, className: 'mono', text: '.err.log' });
  noteBox.append(
    documentRef.createTextNode('等价于 '), mono1,
    documentRef.createTextNode('；日志同时写入终端与 '), mono2,
    documentRef.createTextNode('（后台模式另写 '), mono3,
    documentRef.createTextNode(' / '), mono4,
    documentRef.createTextNode('）。'),
  );

  const card = element('div', { document: documentRef, className: 'card card-flat' });

  const searchInput = element('input', { document: documentRef, className: 'search-input', attributes: { placeholder: '搜索日志内容 / session ID', type: 'text', 'aria-label': '搜索日志' } });
  const levelSelect = element('select', { document: documentRef, className: 'select', attributes: { 'aria-label': '级别筛选' } });
  for (const opt of LEVELS) {
    const o = element('option', { document: documentRef, text: opt === '' ? '级别：全部' : opt, attributes: { value: opt } });
    levelSelect.append(o);
  }
  const sourceSelect = element('select', { document: documentRef, className: 'select', attributes: { 'aria-label': '来源筛选' } });
  for (const opt of SOURCES) {
    const o = element('option', { document: documentRef, text: opt === '' ? '来源：全部' : opt, attributes: { value: opt } });
    sourceSelect.append(o);
  }
  const autoScrollLabel = element('label', { document: documentRef, attributes: { style: 'display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text-secondary);' } });
  const autoScrollCheckbox = element('input', { document: documentRef, attributes: { type: 'checkbox', 'aria-label': '自动滚动' } });
  autoScrollCheckbox.checked = true;
  autoScrollLabel.append(autoScrollCheckbox, documentRef.createTextNode(' 自动滚动'));
  const rowCountSelect = element('select', { document: documentRef, className: 'select', attributes: { 'aria-label': '行数' } });
  for (const n of ROW_COUNTS) {
    const o = element('option', { document: documentRef, text: `最近 ${n} 行`, attributes: { value: String(n) } });
    rowCountSelect.append(o);
  }
  const exportButton = element('button', { document: documentRef, className: 'btn', text: '⬇ 导出', attributes: { type: 'button' } });

  const toolbar = element('div', { document: documentRef, className: 'toolbar' }, searchInput, levelSelect, sourceSelect, autoScrollLabel, rowCountSelect, exportButton);

  const consoleBox = element('div', { document: documentRef, className: 'console-box', attributes: { 'aria-label': '日志内容' } });

  card.append(toolbar, consoleBox);
  root.append(noteBox, card);

  function getFilters() {
    return { query, level, source, autoScroll, rowCount };
  }

  function matchLine(line) {
    const fields = extractLogFields(line);
    if (level && fields.level !== level) return false;
    if (source && fields.source !== source) return false;
    if (query) {
      const q = query.toLowerCase();
      const text = (fields.msg + ' ' + fields.source).toLowerCase();
      if (!text.includes(q)) return false;
    }
    return true;
  }

  function renderLines() {
    const filtered = rawLines.filter(matchLine).slice(-rowCount);
    const fragment = [];
    for (const line of filtered) {
      const fields = extractLogFields(line);
      const lineEl = element('div', { document: documentRef, className: 'log-line' });
      lineEl.append(
        element('span', { document: documentRef, className: 'log-time', text: fields.time }),
        element('span', { document: documentRef, className: `log-level lvl-${fields.level}`, text: fields.level }),
        element('span', { document: documentRef, className: 'log-source', text: fields.source }),
        element('span', { document: documentRef, className: 'log-msg', text: fields.msg }),
      );
      fragment.push(lineEl);
    }
    commit(() => {
      if (!active) return;
      consoleBox.replaceChildren(...fragment);
      if (autoScroll) consoleBox.scrollTop = consoleBox.scrollHeight;
    });
  }

  async function refreshLogs() {
    if (!active || logRequest) return logRequest;
    logRequest = (async () => {
      try {
        const params = new URLSearchParams();
        if (level) params.set('level', level);
        const queryStr = params.toString();
        const payload = responseData(await api.get('/api/admin/logs' + (queryStr ? '?' + queryStr : ''), { signal }));
        const lines = Array.isArray(payload.lines) ? payload.lines : Array.isArray(payload) ? payload : String(payload.content || payload.text || '').split('\n');
        rawLines = lines;
        renderLines();
      } catch (error) {
        if (error?.code !== 'ABORTED' && active) {
          commit(() => {
            consoleBox.replaceChildren(
              element('div', { document: documentRef, className: 'log-line' },
                element('span', { document: documentRef, className: 'log-msg', text: `加载失败：${error?.message || '请求失败'}` }),
              ),
            );
          });
        }
      } finally {
        logRequest = null;
      }
    })();
    return logRequest;
  }

  function setAutoRefresh(enabled) {
    if (timer) clearIntervalFn(timer);
    timer = enabled ? setIntervalFn(() => refreshLogs(), intervalMs) : null;
  }

  function exportLogs() {
    const text = rawLines.filter(matchLine).map(logText).join('\n');
    const now = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    (options.download || ((name, content) => downloadText(documentRef, name, content)))(`walker-logs-${now}.log`, text);
  }


  const cleanups = [];
  cleanups.push(listen(searchInput, 'input', () => { query = searchInput.value; renderLines(); }));
  cleanups.push(listen(levelSelect, 'change', () => { level = levelSelect.value; renderLines(); }));
  cleanups.push(listen(sourceSelect, 'change', () => { source = sourceSelect.value; renderLines(); }));
  cleanups.push(listen(autoScrollCheckbox, 'change', () => { autoScroll = autoScrollCheckbox.checked; }));
  cleanups.push(listen(rowCountSelect, 'change', () => { rowCount = Number(rowCountSelect.value) || 80; renderLines(); }));
  cleanups.push(listen(exportButton, 'click', exportLogs));

  function cleanup() {
    if (!active) return;
    active = false;
    if (timer) clearIntervalFn(timer);
    timer = null;
    for (const dispose of cleanups) dispose();
  }

  return {
    element: root,
    getFilters,
    refreshLogs,
    setAutoRefresh,
    cleanup,
    _test: { rawLines, renderLines, extractLogFields },
  };
}

/** Router 页面入口。 */
export async function mount(context) {
  const workspace = createLogsWorkspace({
    ...context,
    document: context.root.ownerDocument || document,
  });
  context.commit(() => replace(context.root, workspace.element));
  const offRefresh = listen(context.root, 'walker:refresh', () => workspace.refreshLogs());
  await workspace.refreshLogs();
  workspace.setAutoRefresh(true);
  return () => { offRefresh(); workspace.setAutoRefresh(false); workspace.cleanup(); };
}
