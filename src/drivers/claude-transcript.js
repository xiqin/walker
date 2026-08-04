'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function parseClaudeJsonlLine(line) {
  if (!line.trim()) return null;
  const record = JSON.parse(line);
  const assistantText = extractText(record, 'assistant');
  if (assistantText) {
    const message = record.message && typeof record.message === 'object' ? record.message : record;
    const model = typeof message.model === 'string' && message.model ? message.model : undefined;
    const tokenUsage = normalizeTokenUsage(message.usage);
    return {
      type: 'assistant',
      text: assistantText,
      done: message.stop_reason === 'end_turn',
      ...(model ? { model } : {}),
      ...(tokenUsage ? { contextSize: tokenUsage.totalTokens, tokenUsage } : {}),
      raw: record,
    };
  }
  const userText = extractText(record, 'user');
  if (userText) return { type: 'user', text: userText, raw: record };
  return null;
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
      const event = parseClaudeJsonlLine(line);
      if (event) events.push(event);
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
          type: event.type,
          text: event.text,
          model: event.model,
          contextSize: event.contextSize,
          tokenUsage: event.tokenUsage,
          raw: event.raw,
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

module.exports = {
  createTranscriptCursor,
  encodeClaudeProjectPath,
  parseClaudeJsonlLine,
  readAssistantEventsSince,
  readAssistantTextSince,
  resolveClaudeTranscriptPath,
  watchClaudeTranscript,
};
