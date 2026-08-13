'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DIAGNOSTIC_EVENTS = 8;
const SENSITIVE_KEY_RE = /prompt|token|secret|password|api[_-]?key|authorization|input|content/i;

function createTranscriptError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function validateUuid(claudeSessionId) {
  if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
    throw createTranscriptError('CLAUDE_TRANSCRIPT_INVALID_UUID', 'invalid Claude session UUID');
  }
  return claudeSessionId.toLowerCase();
}

function defaultConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function normalizeRealPath(value) {
  return fs.realpathSync.native(value);
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function isInside(child, parent) {
  const resolvedChild = path.resolve(child).toLowerCase();
  const resolvedParent = path.resolve(parent).toLowerCase();
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + path.sep.toLowerCase());
}

function encodeClaudeProjectPath(cwd) {
  return String(cwd).replace(/[\\/:]/g, '-');
}

function resolveCanonicalWorkspace(cwd) {
  if (!cwd || typeof cwd !== 'string') {
    throw createTranscriptError('CLAUDE_TRANSCRIPT_INVALID_WORKSPACE', 'cwd is required');
  }
  let stat;
  try {
    stat = fs.statSync(cwd);
  } catch (err) {
    throw createTranscriptError('CLAUDE_TRANSCRIPT_INVALID_WORKSPACE', 'cwd does not exist', { cwd, cause: err });
  }
  if (!stat.isDirectory()) {
    throw createTranscriptError('CLAUDE_TRANSCRIPT_INVALID_WORKSPACE', 'cwd is not a directory', { cwd });
  }

  const resolvedCwd = path.resolve(cwd);
  const realCwd = normalizeRealPath(cwd);
  if (!samePath(resolvedCwd, realCwd)) {
    throw createTranscriptError('CLAUDE_TRANSCRIPT_PATH_ESCAPE', 'cwd resolves outside the requested workspace path', { cwd, canonicalCwd: realCwd });
  }
  return realCwd;
}

function ensureProjectPathSafe(projectDir, projectsRoot, transcriptPath) {
  const expectedProjectDir = path.resolve(projectDir);
  const expectedProjectsRoot = path.resolve(projectsRoot);
  fs.mkdirSync(expectedProjectsRoot, { recursive: true });
  const projectsRootReal = normalizeRealPath(expectedProjectsRoot);

  if (!isInside(expectedProjectDir, projectsRootReal)) {
    throw createTranscriptError('CLAUDE_TRANSCRIPT_PATH_ESCAPE', 'Claude project path escapes config projects root');
  }

  if (fs.existsSync(expectedProjectDir)) {
    const projectReal = normalizeRealPath(expectedProjectDir);
    if (!samePath(projectReal, expectedProjectDir) || !isInside(projectReal, projectsRootReal)) {
      throw createTranscriptError('CLAUDE_TRANSCRIPT_PATH_ESCAPE', 'Claude project path resolves outside expected workspace');
    }
  }

  if (fs.existsSync(transcriptPath)) {
    const transcriptReal = normalizeRealPath(transcriptPath);
    if (!isInside(transcriptReal, expectedProjectDir)) {
      throw createTranscriptError('CLAUDE_TRANSCRIPT_PATH_ESCAPE', 'Claude transcript resolves outside expected project directory');
    }
  }
}

function resolveClaudeTranscriptPath(options) {
  const cwd = options && options.cwd;
  const configDir = (options && options.configDir) || defaultConfigDir();
  const claudeSessionId = validateUuid(options && options.claudeSessionId);
  if (!configDir) throw createTranscriptError('CLAUDE_TRANSCRIPT_INVALID_PATH', 'configDir is required');
  const canonicalCwd = resolveCanonicalWorkspace(cwd);

  const configRoot = path.resolve(configDir);
  fs.mkdirSync(configRoot, { recursive: true });
  const projectsRoot = path.join(normalizeRealPath(configRoot), 'projects');
  const projectDir = path.join(projectsRoot, encodeClaudeProjectPath(canonicalCwd));
  const transcriptPath = path.join(projectDir, claudeSessionId + '.jsonl');

  ensureProjectPathSafe(projectDir, projectsRoot, transcriptPath);
  return transcriptPath;
}

function initialOffsetFor(file) {
  if (!fs.existsSync(file)) return 0;
  const size = fs.statSync(file).size;
  if (size === 0) return 0;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    if (buf[0] === 10) return size;

    let pos = size - 1;
    const chunk = Buffer.alloc(Math.min(size, 8192));
    while (pos >= 0) {
      const len = Math.min(chunk.length, pos + 1);
      const start = pos - len + 1;
      fs.readSync(fd, chunk, 0, len, start);
      for (let i = len - 1; i >= 0; i--) {
        if (chunk[i] === 10) return start + i + 1;
      }
      pos = start - 1;
    }
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

function createTranscriptCursor(options) {
  const transcriptPath = resolveClaudeTranscriptPath(options);
  return {
    transcriptPath,
    cwd: normalizeRealPath(options.cwd),
    configDir: options.configDir || defaultConfigDir(),
    claudeSessionId: validateUuid(options.claudeSessionId),
    offset: initialOffsetFor(transcriptPath),
    seenToolUseIds: new Set(),
    diagnosticCount: 0,
  };
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(item => item && (item.type == null || item.type === 'text') && typeof item.text === 'string')
    .map(item => item.text)
    .join('\n');
}

function extractText(record, wantedRole) {
  const message = record && record.message && typeof record.message === 'object' ? record.message : record;
  const role = message && (message.role || record.type);
  if (role !== wantedRole) return '';
  return contentToText(message.content);
}

function normalizeTokenUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const tokenCount = value => Number.isFinite(value) && value >= 0 ? value : 0;
  const tokenUsage = {
    inputTokens: tokenCount(usage.input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
    cacheReadTokens: tokenCount(usage.cache_read_input_tokens),
    cacheWriteTokens: tokenCount(usage.cache_creation_input_tokens),
  };
  tokenUsage.totalTokens = tokenUsage.inputTokens + tokenUsage.outputTokens
    + tokenUsage.cacheReadTokens + tokenUsage.cacheWriteTokens;
  return tokenUsage;
}

function eventMeta(record) {
  const message = record && record.message && typeof record.message === 'object' ? record.message : record;
  const model = typeof message.model === 'string' && message.model ? message.model : undefined;
  const tokenUsage = normalizeTokenUsage(message.usage);
  return {
    ...(model ? { model } : {}),
    ...(tokenUsage ? { contextSize: tokenUsage.totalTokens, tokenUsage } : {}),
    raw: record,
  };
}

function sanitizeText(value) {
  return String(value == null ? '' : value)
    .replace(/(WALKER_ADMIN_TOKEN|FEISHU_APP_SECRET|TOKEN|SECRET|PASSWORD|API_KEY)=([^\s]+)/gi, '$1=[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\-/]+=*/gi, '$1[redacted]');
}

function sanitizeStableObject(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(item => sanitizeStableObject(item));
  if (typeof value === 'object') {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) continue;
      if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') result[key] = sanitizeText(child);
    }
    return result;
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

function stringifyToolResult(content) {
  if (typeof content === 'string') return sanitizeText(content);
  if (!Array.isArray(content)) return sanitizeText(content == null ? '' : JSON.stringify(sanitizeStableObject(content)));
  return content.map((item) => {
    if (!item || typeof item !== 'object') return sanitizeText(item);
    if (typeof item.text === 'string') return sanitizeText(item.text);
    if (typeof item.content === 'string') return sanitizeText(item.content);
    return sanitizeText(JSON.stringify(sanitizeStableObject(item)));
  }).filter(Boolean).join('\n');
}

function diagnosticEvent(kind, detail, record) {
  const diagnostic = {
    kind,
    ...(detail || {}),
  };
  if (!diagnostic.rawType && record && record.type) diagnostic.rawType = sanitizeText(record.type).slice(0, 80);
  return {
    type: 'status',
    status: 'claude-transcript-diagnostic',
    diagnostic,
  };
}

function maybePushDiagnostic(events, state, event) {
  if (!state) state = {};
  if (state.diagnosticCount == null) state.diagnosticCount = 0;
  if (state.diagnosticCount >= MAX_DIAGNOSTIC_EVENTS) return;
  state.diagnosticCount += 1;
  events.push(event);
}

function contentParts(message) {
  if (!message) return [];
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  return Array.isArray(message.content) ? message.content : [];
}

function mapToolUse(part, meta, state) {
  const callID = typeof part.id === 'string' && part.id ? part.id : (typeof part.tool_use_id === 'string' && part.tool_use_id ? part.tool_use_id : undefined);
  if (callID && state && state.seenToolUseIds) state.seenToolUseIds.add(callID);
  return {
    type: 'tool_use',
    name: typeof part.name === 'string' ? part.name : '',
    input: part.input && typeof part.input === 'object' && !Array.isArray(part.input) ? part.input : {},
    status: 'pending',
    phase: 'start',
    ...(callID ? { callID } : {}),
    ...meta,
  };
}

function mapToolResult(part, meta, state) {
  const callID = typeof part.tool_use_id === 'string' && part.tool_use_id ? part.tool_use_id : (typeof part.id === 'string' && part.id ? part.id : undefined);
  const seen = !!(callID && state && state.seenToolUseIds && state.seenToolUseIds.has(callID));
  const isError = Boolean(part.is_error || part.isError);
  return {
    type: 'tool_use',
    name: typeof part.name === 'string' ? part.name : (callID || ''),
    output: stringifyToolResult(part.content),
    result: stringifyToolResult(part.content),
    status: isError ? 'error' : 'done',
    phase: 'result',
    isError,
    orphan: !seen,
    ...(callID ? { callID } : {}),
    ...meta,
  };
}

function mapContentBlock(part, meta, state, record) {
  if (!part || typeof part !== 'object') return null;
  if ((part.type == null || part.type === 'text') && typeof part.text === 'string') return { type: 'assistant', text: part.text, ...meta };
  if ((part.type === 'thinking' || part.type === 'reasoning') && (typeof part.thinking === 'string' || typeof part.text === 'string')) {
    return { type: 'reasoning', text: part.thinking || part.text, ...meta };
  }
  if (part.type === 'tool_use') return mapToolUse(part, meta, state);
  if (part.type === 'tool_result') return mapToolResult(part, meta, state);
  const events = [];
  maybePushDiagnostic(events, state, diagnosticEvent('unknown-content-block', { rawType: sanitizeText(part.type || 'unknown').slice(0, 80) }, record));
  return events[0] || null;
}

function mapQuestionRecord(record) {
  const requestID = sanitizeText(record.request_id || record.requestID || record.id || 'unknown').slice(0, 120);
  const sessionID = sanitizeText(record.session_id || record.sessionID || record.sessionId || 'unknown').slice(0, 120);
  const questionText = sanitizeText(record.question || record.title || record.message || 'Claude question').slice(0, 200);
  const header = sanitizeText(record.header || record.tool_name || record.tool || record.type || 'question').slice(0, 120);
  const event = {
    type: 'question_asked',
    requestID,
    sessionID,
    questions: [{ question: questionText, header, options: [] }],
  };
  if (record.tool_name || record.tool) event.tool = { name: sanitizeText(record.tool_name || record.tool).slice(0, 120) };
  return event;
}

function mapHookRecord(record) {
  return diagnosticEvent('claude-hook', {
    hookEventName: sanitizeText(record.hook_event_name || record.hookEventName || record.name || 'hook').slice(0, 120),
    ...(record.tool_name ? { tool: { name: sanitizeText(record.tool_name).slice(0, 120) } } : {}),
  }, record);
}

function parseClaudeJsonlLineEvents(line, options) {
  if (!line.trim()) return [];
  const state = options || {};
  let record;
  try {
    record = JSON.parse(line);
  } catch (err) {
    const events = [];
    maybePushDiagnostic(events, state, diagnosticEvent('bad-json', { message: sanitizeText(err.message).slice(0, 120) }));
    return events;
  }
  if (!record || typeof record !== 'object') return [];
  const message = record.message && typeof record.message === 'object' ? record.message : record;
  const role = message.role || record.type;
  const meta = eventMeta(record);
  if (record.type === 'question' || record.type === 'permission_request') return [mapQuestionRecord(record)];
  if (record.type === 'hook' || record.hook_event_name || record.hookEventName) return [mapHookRecord(record)];

  const events = [];
  if (role === 'assistant') {
    for (const part of contentParts(message)) {
      const event = mapContentBlock(part, meta, state, record);
      if (event) events.push(event);
    }
    if (message.stop_reason === 'end_turn') events.forEach(event => { event.done = true; });
    return events;
  }
  if (role === 'user') {
    for (const part of contentParts(message)) {
      if (part.type === 'tool_result') {
        const event = mapToolResult(part, meta, state);
        events.push(event);
      } else if ((part.type == null || part.type === 'text') && typeof part.text === 'string') {
        events.push({ type: 'user', text: part.text, ...meta });
      } else {
        maybePushDiagnostic(events, state, diagnosticEvent('unknown-content-block', { rawType: sanitizeText(part.type || 'unknown').slice(0, 80) }, record));
      }
    }
    return events;
  }
  if (record.type) maybePushDiagnostic(events, state, diagnosticEvent('unknown-record', {}, record));
  return events;
}

function parseClaudeJsonlLine(line) {
  return parseClaudeJsonlLineEvents(line)[0] || null;
}

function readCompleteLines(cursor) {
  if (!fs.existsSync(cursor.transcriptPath)) {
    return { events: [], nextOffset: cursor.offset, status: 'missing', partial: false };
  }
  const stat = fs.statSync(cursor.transcriptPath);
  if (stat.size <= cursor.offset) {
    return { events: [], nextOffset: cursor.offset, status: 'complete', partial: false };
  }

  const fd = fs.openSync(cursor.transcriptPath, 'r');
  try {
    const length = stat.size - cursor.offset;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, cursor.offset);
    const lastNewline = buf.lastIndexOf(10);
    if (lastNewline === -1) {
      return { events: [], nextOffset: cursor.offset, status: 'partial', partial: true };
    }

    const complete = buf.subarray(0, lastNewline + 1).toString('utf8');
    const partial = lastNewline < buf.length - 1;
    const lines = complete.split(/\r?\n/).filter(Boolean);
    const events = [];
    for (const line of lines) {
      for (const event of parseClaudeJsonlLineEvents(line, cursor)) {
        if (event) events.push(event);
      }
    }
    return { events, nextOffset: cursor.offset + Buffer.byteLength(complete), status: partial ? 'partial' : 'complete', partial };
  } finally {
    fs.closeSync(fd);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readAssistantTextSince(cursor, options = {}) {
  const events = await readAssistantEventsSince(cursor, options);
  return events.map(event => event.text).filter(Boolean).join('\n');
}

async function readAssistantEventsSince(cursor, options = {}) {
  const timeoutMs = options.timeoutMs == null ? 30000 : options.timeoutMs;
  const pollIntervalMs = options.pollIntervalMs || 100;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'complete';

  while (Date.now() <= deadline) {
    const result = readCompleteLines(cursor);
    cursor.offset = result.nextOffset;
    lastStatus = result.status;
    const events = result.events.filter(event => event.type === 'assistant' && event.text);
    if (events.length > 0) return events;
    if (timeoutMs === 0) break;
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }

  const code = lastStatus === 'missing'
    ? 'CLAUDE_TRANSCRIPT_MISSING'
    : lastStatus === 'partial'
      ? 'CLAUDE_TRANSCRIPT_PARTIAL_LINE_TIMEOUT'
      : 'CLAUDE_TRANSCRIPT_TIMEOUT';
  throw createTranscriptError(code, 'timed out waiting for assistant text', {
    transcriptPath: cursor.transcriptPath,
    claudeSessionId: cursor.claudeSessionId,
    offset: cursor.offset,
    status: lastStatus,
  });
}

function watchClaudeTranscript(options) {
  const cursor = createTranscriptCursor(options);
  const pollIntervalMs = options.pollIntervalMs || 100;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  let closed = false;
  let timer = null;

  function emitAvailable() {
    if (closed) return;
    try {
      const result = readCompleteLines(cursor);
      cursor.offset = result.nextOffset;
      for (const event of result.events) {
        onEvent({
          ...event,
          claudeSessionId: cursor.claudeSessionId,
          transcriptPath: cursor.transcriptPath,
        });
        if (event.type === 'assistant' && event.done) {
          onEvent({
            type: 'done',
            model: event.model,
            contextSize: event.contextSize,
            tokenUsage: event.tokenUsage,
            raw: event.raw,
            claudeSessionId: cursor.claudeSessionId,
            transcriptPath: cursor.transcriptPath,
          });
        }
      }
    } catch (err) {
      onEvent({ type: 'error', error: err, claudeSessionId: cursor.claudeSessionId, transcriptPath: cursor.transcriptPath });
    }
    if (!closed) timer = setTimeout(emitAvailable, pollIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function close() {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  if (options.signal) {
    if (options.signal.aborted) close();
    else options.signal.addEventListener('abort', close, { once: true });
  }

  timer = setTimeout(emitAvailable, 0);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return { close, cursor };
}

function readTailRecords(filePath, maxBytes) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return [];
  }
  const total = stat.size;
  if (!total) return [];
  let start = Math.max(0, total - maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    if (start > 0) {
      const probeLen = Math.min(start, 8192);
      const probe = Buffer.alloc(probeLen);
      fs.readSync(fd, probe, 0, probeLen, start - probeLen);
      const lastNl = probe.lastIndexOf(10);
      if (lastNl >= 0) start = start - probeLen + lastNl + 1;
    }
    const length = total - start;
    if (length <= 0) return [];
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
    const records = [];
    for (const line of lines) {
      try { records.push(JSON.parse(line)); } catch (_) {}
    }
    return records;
  } finally {
    fs.closeSync(fd);
  }
}

function readHeadRecords(filePath, maxBytes) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return [];
  }
  const total = stat.size;
  if (!total) return [];
  const length = Math.min(total, maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, 0);
    const lastNl = buf.lastIndexOf(10);
    const complete = lastNl === -1 ? buf.toString('utf8') : buf.subarray(0, lastNl + 1).toString('utf8');
    const lines = complete.split(/\r?\n/).filter(Boolean);
    const records = [];
    for (const line of lines) {
      try { records.push(JSON.parse(line)); } catch (_) {}
    }
    return records;
  } finally {
    fs.closeSync(fd);
  }
}

function readSessionMetadata(filePath, id) {
  let updatedAt = 0;
  let title = '';
  const cwds = [];
  try {
    const head = readHeadRecords(filePath, 16384);
    const tail = readTailRecords(filePath, 204800);
    const all = head.concat(tail);
    for (const record of head) {
      if (!title) {
        const text = extractText(record, 'user');
        if (text) title = String(text).replace(/\s+/g, ' ').trim().slice(0, 60);
      }
    }
    if (!title) {
      for (const record of tail) {
        const text = extractText(record, 'user');
        if (text) { title = String(text).replace(/\s+/g, ' ').trim().slice(0, 60); break; }
      }
    }
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const record = all[i];
      if (!updatedAt && record && typeof record.timestamp === 'string') {
        const parsed = Date.parse(record.timestamp);
        if (Number.isFinite(parsed)) updatedAt = parsed;
      }
      if (record && typeof record.cwd === 'string' && record.cwd && !cwds.includes(record.cwd)) {
        cwds.push(record.cwd);
      }
      if (updatedAt) break;
    }
    // 收集 head 中可能存在的 cwd（updatedAt 已找到会提前 break，这里补全 cwds）
    for (const record of head) {
      if (record && typeof record.cwd === 'string' && record.cwd && !cwds.includes(record.cwd)) cwds.push(record.cwd);
    }
  } catch (_) {}
  if (!updatedAt) {
    try { updatedAt = fs.statSync(filePath).mtimeMs; } catch (_) { updatedAt = 0; }
  }
  if (!title) title = 'claude ' + id.slice(0, 8);
  return { updatedAt, title, cwds };
}

/**
 * 将编码后的 Claude project 目录名启发式还原为 cwd（兜底，可能有损）。
 * encodeClaudeProjectPath 将 [\\/:] 替换为 '-'，此处按平台常见形态反推。
 * @param {string} dirName - 编码后的目录名
 * @returns {string} 还原后的 cwd 字符串
 */
function decodeClaudeProjectPath(dirName) {
  const s = String(dirName || '');
  if (/^[A-Za-z]--/.test(s)) return s[0] + ':\\' + s.slice(3).replace(/-/g, '\\');
  if (s.startsWith('-')) return '/' + s.slice(1).replace(/-/g, '/');
  return s.replace(/-/g, '\\');
}

/**
 * 从候选 cwd 中挑选与编码目录名匹配的那个（无损验证）；无匹配则启发式解码。
 * @param {string} dirName - 编码后的 project 目录名
 * @param {string[]} cwds - 从 transcript 记录读到的候选 cwd
 * @returns {string} 还原后的 cwd
 */
function pickProjectCwd(dirName, cwds) {
  const seen = new Set();
  for (const cwd of cwds || []) {
    if (!cwd || typeof cwd !== 'string' || seen.has(cwd)) continue;
    seen.add(cwd);
    try {
      const real = fs.realpathSync.native(cwd);
      if (encodeClaudeProjectPath(real) === dirName) return real;
    } catch (_) {}
  }
  return decodeClaudeProjectPath(dirName);
}

/**
 * 列出某 cwd 下的 Claude 历史会话（扫描 <configDir>/projects/<编码cwd>/*.jsonl）。
 * 返回字段与 OpenCode attach 卡片契约对齐：{id, title, status, cwd, updatedAt}，
 * updatedAt 为 epoch 毫秒数。cwd 不存在或无会话时返回 []，不抛错。
 * @param {Object} options - { cwd, configDir }
 * @returns {Array<{id:string,title:string,status:string,cwd:string,updatedAt:number}>}
 */
function listClaudeSessionsForCwd(options) {
  const opts = options || {};
  const cwd = opts.cwd;
  if (!cwd || typeof cwd !== 'string') return [];
  let canonicalCwd;
  try {
    canonicalCwd = resolveCanonicalWorkspace(cwd);
  } catch (_) {
    return [];
  }
  const configRoot = path.resolve(opts.configDir || defaultConfigDir());
  const projectsRoot = path.join(configRoot, 'projects');
  const projectDir = path.join(projectsRoot, encodeClaudeProjectPath(canonicalCwd));
  if (!isInside(projectDir, projectsRoot)) return [];
  let files;
  try {
    files = fs.readdirSync(projectDir);
  } catch (_) {
    return [];
  }
  const sessions = [];
  for (const file of files) {
    if (typeof file !== 'string' || !file.endsWith('.jsonl')) continue;
    const id = file.slice(0, -6);
    if (!UUID_RE.test(id)) continue;
    const filePath = path.join(projectDir, file);
    const meta = readSessionMetadata(filePath, id);
    sessions.push({
      id: id.toLowerCase(),
      title: meta.title,
      status: 'idle',
      cwd: canonicalCwd,
      updatedAt: meta.updatedAt,
    });
  }
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return sessions;
}

/**
 * 列出 <configDir>/projects 下所有项目目录的全部 Claude 历史会话。
 * cwd 从 transcript 记录的 cwd 字段无损还原（用 encodeClaudeProjectPath(realpath) 验证匹配目录名），
 * 无记录 cwd 时启发式解码目录名。updatedAt 为 epoch 毫秒数，按倒序返回。
 * @param {Object} options - { configDir }
 * @returns {Array<{id:string,title:string,status:string,cwd:string,updatedAt:number}>}
 */
function listAllClaudeSessions(options) {
  const opts = options || {};
  const configRoot = path.resolve(opts.configDir || defaultConfigDir());
  const projectsRoot = path.join(configRoot, 'projects');
  let entries;
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const sessions = [];
  for (const entry of entries) {
    if (!entry || !entry.isDirectory() || typeof entry.name !== 'string') continue;
    const dirName = entry.name;
    const projectDir = path.join(projectsRoot, dirName);
    if (!isInside(projectDir, projectsRoot)) continue;
    let files;
    try {
      files = fs.readdirSync(projectDir);
    } catch (_) {
      continue;
    }
    for (const file of files) {
      if (typeof file !== 'string' || !file.endsWith('.jsonl')) continue;
      const id = file.slice(0, -6);
      if (!UUID_RE.test(id)) continue;
      const filePath = path.join(projectDir, file);
      const meta = readSessionMetadata(filePath, id);
      sessions.push({
        id: id.toLowerCase(),
        title: meta.title,
        status: 'idle',
        cwd: pickProjectCwd(dirName, meta.cwds),
        updatedAt: meta.updatedAt,
      });
    }
  }
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return sessions;
}

module.exports = {
  createTranscriptCursor,
  decodeClaudeProjectPath,
  defaultConfigDir,
  encodeClaudeProjectPath,
  listAllClaudeSessions,
  listClaudeSessionsForCwd,
  parseClaudeJsonlLine,
  parseClaudeJsonlLineEvents,
  readAssistantEventsSince,
  readAssistantTextSince,
  resolveClaudeTranscriptPath,
  watchClaudeTranscript,
};
