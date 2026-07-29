'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const { AgentDriver, AgentEvent } = require('./agent-driver');
const { createLogger } = require('../core/logger');
const { mapSSEEvent, isTerminalSSEEvent } = require('./opencode-sse-adapter');
const { OpencodeSessionWatcher } = require('./opencode-session-watcher');
const {
  DefaultHttpClient, DefaultSSEClient, buildUrl, summarizeResponse,
  extractModelList, extractSessionList, extractMessageList,
  extractProjectList, normalizeSessionSummary,
} = require('./opencode-http-client');

const logger = createLogger('opencode-driver');

function defaultSqliteCmd() {
  if (process.env.WALKER_SQLITE_CMD) return process.env.WALKER_SQLITE_CMD;
  if (process.env.SQLITE3_PATH) return process.env.SQLITE3_PATH;
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'SQLite', 'sqlite3.exe'),
    'I:\\phpStudy\\Apache\\bin\\sqlite3.exe',
    'C:\\Android\\platform-tools\\sqlite3.exe',
  ];
  for (const candidate of candidates) {
    try {
      if (fsSync.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return 'sqlite3';
}

class OpencodeDriver extends AgentDriver {
  constructor(options) {
    super('opencode');
    this.httpClient = options.httpClient || new DefaultHttpClient();
    this.sseClient = options.sseClient || new DefaultSSEClient();
    this.serverUrl = options.serverUrl || '';
    if (!this.serverUrl) {
      throw new Error('opencode-driver requires serverUrl');
    }
    this.autostart = options.autostart !== undefined ? options.autostart : true;
    this.runtime = options.runtime || null;
    this.opencodeCmd = options.opencodeCmd || 'opencode';
    this.pollInterval = options.pollInterval || 500;
    this.maxPolls = options.maxPolls || 20;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 120000;
    this.sseOpenTimeoutMs = options.sseOpenTimeoutMs ?? 1000;
    this.promptRequestTimeoutMs = options.promptRequestTimeoutMs ?? 30000;
    this.sseIdleTimeoutMs = options.sseIdleTimeoutMs ?? 300000;
    this.recoveryWindowMs = options.recoveryWindowMs ?? 300000;
    this.tuiBridge = options.tuiBridge || null;
    this.sqliteCmd = options.sqliteCmd || defaultSqliteCmd();
    this.execFile = options.execFile || promisify(childProcess.execFile);
    this.opencodeDbPath = options.opencodeDbPath || path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
    this._hasModelStateOverride = Object.prototype.hasOwnProperty.call(options, 'modelState');
    this.modelState = options.modelState;
    const stateRoot = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    this.modelStatePath = options.modelStatePath || path.join(stateRoot, 'opencode', 'model.json');

    this._sessionWatcher = new OpencodeSessionWatcher({
      sseClient: this.sseClient,
      buildUrl: (path, query, sessionRef) => this._buildUrl(path, query, sessionRef),
      watchTimeoutMs: options.watchTimeoutMs || 300000,
      pollIntervalMs: options.messagePollIntervalMs || 3000,
      getSessionMessages: (ref, messageOptions) => this.getSessionMessages(ref, messageOptions),
    });
  }

  async ensureReady() {
    if (await this._checkHealth()) {
      logger.info('opencode server already ready');
      return true;
    }

    if (!this.autostart) {
      throw new Error('opencode server not available at ' + this.serverUrl + '. Set OPENCODE_SERVER_AUTOSTART=true or start manually.');
    }

    logger.info('autostarting opencode server');
    this._startServer();

    for (let i = 0; i < this.maxPolls; i++) {
      await this._sleep(this.pollInterval);
      if (await this._checkHealth()) {
        logger.info('opencode server started successfully');
        return true;
      }
    }

    throw new Error('opencode server failed to start at ' + this.serverUrl + ' after ' + (this.maxPolls * this.pollInterval) + 'ms');
  }

  async createSession(options) {
    const cwd = options.cwd || process.cwd();
    const v2Url = this._buildUrl('/api/session', {});
    const v2Body = {
      location: { directory: cwd },
    };
    const v2Model = this._modelRefToApiModel(options.model);
    if (v2Model) v2Body.model = v2Model;
    if (options.agent) v2Body.agent = options.agent;

    try {
      let resp = await this.httpClient.request('POST', v2Url, v2Body);
      let status = resp && resp.status;
      if (status === 404 || status === 405) {
        const legacyUrl = this._buildUrl('/session', { directory: cwd });
        const legacyBody = {
          title: options.title || 'walker session',
        };
        if (options.model) legacyBody.model = options.model;
        if (options.agent) legacyBody.agent = options.agent;
        resp = await this.httpClient.request('POST', legacyUrl, legacyBody);
        status = resp && resp.status;
      }
      const responseSummary = this._summarizeResponse(resp);
      if (typeof status === 'number' && (status < 200 || status >= 300)) {
        throw new Error('HTTP ' + status + ' from ' + this.serverUrl + ': ' + responseSummary);
      }

      const data = resp && resp.data;
      const sessionData = data && data.data ? data.data : data;
      const sessionId = resp && (resp.id || resp.sessionID || resp.sessionId || (sessionData && (sessionData.id || sessionData.sessionID || sessionData.sessionId)));
      if (!sessionId) {
        throw new Error('missing session id from ' + this.serverUrl + ': ' + responseSummary);
      }
      logger.info('opencode session created', { opencodeSessionId: sessionId });

      const sessionCwd = (sessionData && sessionData.location && sessionData.location.directory) || resp.directory || cwd;
      await this._openTerminalForSession(sessionId, sessionCwd);

      return {
        opencodeSessionId: sessionId,
        serverUrl: this.serverUrl,
        cwd: sessionCwd,
      };
    } catch (err) {
      throw new Error('Failed to create opencode session at ' + this.serverUrl + ': ' + err.message);
    }
  }

  _modelRefToApiModel(model) {
    const normalized = this._normalizeModelRef(model);
    if (!normalized || !normalized.modelID) return null;
    const apiModel = { id: normalized.modelID };
    if (normalized.providerID) apiModel.providerID = normalized.providerID;
    return apiModel;
  }

  async resumeSession(sessionRef) {
    if (!sessionRef || !sessionRef.opencodeSessionId) {
      throw new Error('resumeSession requires sessionRef with opencodeSessionId');
    }
    logger.info('resuming opencode session', { sessionId: sessionRef.opencodeSessionId });
    return sessionRef;
  }

  async listModels() {
    const url = this._buildUrl('/api/model', {});
    try {
      const resp = await this.httpClient.request('GET', url, null);
      const runtimeModels = this._extractModelList(resp);
      const modelState = await this._loadModelState();
      const recentModels = this._extractRecentModels(modelState);
      const models = this._mergeRecentModels(recentModels, runtimeModels);
      return models.map((m) => this._normalizeModel(m)).filter((m) => m.id && m.enabled);
    } catch (err) {
      throw new Error('Failed to list models at ' + this.serverUrl + ': ' + err.message);
    }
  }

  async getCurrentModel() {
    const modelState = await this._loadModelState();
    return this._extractCurrentModel(modelState);
  }

  async getLatestSessionRuntime(sessionRef) {
    if (!sessionRef || !sessionRef.opencodeSessionId) return null;
    if (sessionRef.transport === 'tui-bridge') {
      return this._getLatestSessionRuntimeFromLocalDb(sessionRef.opencodeSessionId);
    }

    try {
      const messages = await this._getSessionMessagesHttp(sessionRef);
      const runtime = this._latestRuntimeFromMessages(messages);
      if (runtime) return runtime;
    } catch (err) {
      logger.debug('failed to read latest session runtime from opencode http', {
        sessionId: sessionRef.opencodeSessionId,
        error: err && err.message,
      });
    }

    if (sessionRef.transport !== 'tui-bridge') {
      return this._getLatestSessionRuntimeFromLocalDb(sessionRef.opencodeSessionId);
    }

    return null;
  }

  async _getLatestSessionRuntimeFromLocalDb(sessionId) {
    try {
      const messages = await this._getSessionMessagesFromLocalDb(sessionId);
      const runtime = this._latestRuntimeFromMessages(messages);
      if (runtime) {
        logger.info('latest session runtime loaded from opencode db', {
          sessionId,
          contextSize: runtime.contextSize,
          model: runtime.model,
        });
      } else {
        logger.info('latest session runtime not found in opencode db', {
          sessionId,
          messageCount: Array.isArray(messages) ? messages.length : 0,
        });
      }
      return runtime;
    } catch (err) {
      logger.warn('failed to read latest session runtime from opencode db', {
        sessionId,
        sqliteCmd: this.sqliteCmd,
        dbPath: this.opencodeDbPath,
        error: err && err.message,
      });
      return null;
    }
  }

  async _getSessionMessagesHttp(sessionRef) {
    const sessionId = sessionRef.opencodeSessionId;
    const url = this._buildUrl('/session/' + sessionId + '/message', {}, sessionRef);
    const resp = await this.httpClient.request('GET', url);
    return this._extractMessageList(resp);
  }

  async _getSessionMessagesFromLocalDb(sessionId, options) {
    const limit = this._messageLimit(options && options.limit, 20);
    const escaped = String(sessionId).replace(/'/g, "''");
    const sql = 'select data from message where session_id=\'' + escaped + '\' order by time_created desc limit ' + limit + ';';
    const result = await this.execFile(this.sqliteCmd, ['-batch', '-noheader', this.opencodeDbPath, sql], { encoding: 'utf8' });
    const stdout = typeof result === 'string' ? result : (result && result.stdout) || '';
    return stdout.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean)
      .reverse();
  }

  _messageLimit(value, fallback) {
    const limit = Number(value);
    if (!Number.isFinite(limit) || limit <= 0) return fallback;
    return Math.min(Math.floor(limit), 100);
  }

  async _getSessionMessagesForWatcher(sessionRef, options) {
    const sessionId = sessionRef.opencodeSessionId;
    try {
      if (this.opencodeDbPath && fsSync.existsSync(this.opencodeDbPath)) {
        const messages = await this._getSessionMessagesFromLocalDb(sessionId, { limit: options && options.limit });
        if (messages.length > 0) return messages;
      }
    } catch (err) {
      logger.debug('failed to read watcher messages from opencode db, falling back to http', {
        sessionId,
        error: err && err.message,
      });
    }
    return this._getSessionMessagesHttp(sessionRef);
  }

  _latestRuntimeFromMessages(messages) {
    let latest = null;
    for (const entry of messages || []) {
      const runtime = this._runtimeFromMessage(entry);
      if (!runtime) continue;
      if (!latest || runtime.completedAt >= latest.completedAt) latest = runtime;
    }
    if (!latest) return null;
    return {
      model: latest.model,
      contextSize: latest.contextSize,
      tokenUsage: latest.tokenUsage,
    };
  }

  _runtimeFromMessage(entry) {
    const message = entry && (entry.info || entry.data || entry);
    if (!message || message.role !== 'assistant') return null;
    const completedAt = this._messageCompletedAt(message);
    if (completedAt === null) return null;
    const tokenUsage = this._tokenUsageFromTokens(message.tokens);
    if (!tokenUsage) return null;
    return {
      completedAt,
      model: this._normalizeModelRef({ providerID: message.providerID || message.provider, modelID: message.modelID || message.modelId || message.model }),
      contextSize: tokenUsage.totalTokens,
      tokenUsage,
    };
  }

  _messageCompletedAt(message) {
    const time = message && message.time;
    const completed = time && (time.completed || time.completedAt || time.completed_at);
    const value = completed || message.completedAt || message.completed_at || message.timeCompleted;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  _tokenUsageFromTokens(tokens) {
    if (!tokens || typeof tokens !== 'object') return null;
    const inputTokens = this._nonNegativeNumber(tokens.input ?? tokens.inputTokens ?? tokens.input_tokens) || 0;
    const outputTokens = this._nonNegativeNumber(tokens.output ?? tokens.outputTokens ?? tokens.output_tokens) || 0;
    const reasoningTokens = this._nonNegativeNumber(tokens.reasoning ?? tokens.reasoningTokens ?? tokens.reasoning_tokens) || 0;
    const cache = tokens.cache || {};
    const cacheReadTokens = this._nonNegativeNumber(cache.read ?? tokens.cacheReadTokens ?? tokens.cache_read_tokens) || 0;
    const cacheWriteTokens = this._nonNegativeNumber(cache.write ?? tokens.cacheWriteTokens ?? tokens.cache_write_tokens) || 0;
    const total = this._nonNegativeNumber(tokens.total ?? tokens.totalTokens ?? tokens.total_tokens);
    const totalTokens = total !== null ? total : inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens;
    if (totalTokens <= 0) return null;
    return { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
  }

  _nonNegativeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  async _loadModelState() {
    if (this._hasModelStateOverride) return this.modelState;
    try {
      const content = await fs.readFile(this.modelStatePath, 'utf8');
      return JSON.parse(content);
    } catch (_) {
      return null;
    }
  }

  _extractCurrentModel(modelState) {
    if (!modelState || typeof modelState !== 'object') return null;
    const direct = modelState.currentModel || modelState.current || modelState.model || modelState.selected;
    const model = this._normalizeModelRef(direct);
    if (model) return model;
    const recent = Array.isArray(modelState.recent) ? modelState.recent : [];
    return this._normalizeModelRef(recent[0]);
  }

  _normalizeModelRef(model) {
    if (!model) return null;
    if (typeof model === 'string') {
      const trimmed = model.trim();
      if (!trimmed) return null;
      if (trimmed.includes('/')) {
        const parts = trimmed.split('/');
        return { providerID: parts[0], modelID: parts.slice(1).join('/') };
      }
      return { providerID: '', modelID: trimmed };
    }
    if (typeof model !== 'object') return null;
    const providerID = model.providerID || model.provider || '';
    const modelID = model.modelID || model.id || '';
    if (!providerID && !modelID) return null;
    return { providerID, modelID };
  }

  _extractRecentModels(modelState) {
    const recent = modelState && Array.isArray(modelState.recent) ? modelState.recent : [];
    const models = [];
    for (const model of recent) {
      const providerID = model && (model.providerID || model.provider);
      const modelID = model && (model.modelID || model.id);
      if (!providerID || !modelID) continue;
      models.push({ providerID, id: modelID, name: modelID, groups: ['recent'] });
    }
    return models;
  }

  _mergeRecentModels(recentModels, runtimeModels) {
    const runtimeByKey = new Map(runtimeModels.map((model) => [this._modelKey(model), model]));
    const seen = new Set();
    const merged = [];
    for (const model of recentModels) {
      const key = this._modelKey(model);
      if (seen.has(key)) continue;
      seen.add(key);
      const runtimeModel = runtimeByKey.get(key);
      if (!runtimeModel) {
        merged.push(model);
        continue;
      }
      runtimeByKey.delete(key);
      const groups = this._normalizeModelGroups(runtimeModel);
      if (!groups.includes('recent')) groups.push('recent');
      merged.push({ ...runtimeModel, groups });
    }
    return merged.concat([...runtimeByKey.values()]);
  }

  _modelKey(model) {
    const provider = model && (model.providerID || model.provider) || '';
    const id = model && (model.id || model.modelID) || '';
    return provider + '/' + id;
  }

  _normalizeModel(m) {
    const groups = this._normalizeModelGroups(m);
    const id = m.id || m.modelID || '';
    const provider = m.providerID || m.provider || '';
    return {
      id,
      name: m.name || m.modelName || '',
      provider,
      status: m.status || '',
      enabled: m.enabled !== undefined ? m.enabled : true,
      source: 'opencode',
      groups,
      lastUsedAt: m.lastUsedAt || m.lastUsed || m.last_used_at || null,
    };
  }

  _normalizeModelGroups(m) {
    const groups = [];
    const addGroup = (value) => {
      if (!value) return;
      const group = String(value);
      if (!groups.includes(group)) groups.push(group);
    };
    if (Array.isArray(m.groups)) {
      for (const group of m.groups) addGroup(group);
    } else {
      addGroup(m.groups);
    }

    const category = m.group || m.category;
    if (String(category || '').toLowerCase() === 'recent') addGroup('recent');
    if (m.recent === true || m.lastUsedAt || m.lastUsed || m.last_used_at) addGroup('recent');
    return groups;
  }

  async updateConfig(patch) {
    const url = this._buildUrl('/config', {});
    try {
      const resp = await this.httpClient.request('PATCH', url, patch);
      const status = resp && resp.status;
      const responseSummary = this._summarizeResponse(resp);
      if (typeof status === 'number' && (status < 200 || status >= 300)) {
        throw new Error('HTTP ' + status + ' from ' + this.serverUrl + ': ' + responseSummary);
      }
      logger.info('opencode config updated', { patch });
      return resp && resp.data !== undefined ? resp.data : resp;
    } catch (err) {
      throw new Error('Failed to update opencode config at ' + this.serverUrl + ': ' + err.message);
    }
  }

  async listSessions(options) {
    const cwd = options && options.cwd;
    if (cwd) {
      return this._listSessionsForDirectory(cwd);
    }
    return this._listAllSessions(options && options.extraCwds);
  }

  async prompt(sessionRef, text, options) {
    if (!sessionRef || !sessionRef.opencodeSessionId) {
      throw new Error('prompt requires sessionRef with opencodeSessionId');
    }

    if (this._isTuiBridge(sessionRef)) {
      return this.tuiBridge.prompt(sessionRef, text, options);
    }

    const sessionId = sessionRef.opencodeSessionId;
    this._sessionWatcher.suspend(sessionRef);
    const promptUrl = this._buildUrl('/session/' + sessionId + '/prompt_async', { directory: sessionRef.cwd }, sessionRef);
    const body = { parts: [{ type: 'text', text }] };
    if (options && options.model) {
      const m = options.model;
      if (typeof m === 'string') {
        body.model = { modelID: m };
      } else {
        body.model = m;
      }
    }

    const events = [];
    const sseUrl = this._buildUrl('/event', { directory: sessionRef.cwd }, sessionRef);
    let markSSEOpen;
    const sseOpened = new Promise((resolve) => { markSSEOpen = resolve; });

    const externalSignal = options && options.signal;
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    const baselineId = this._sessionWatcher.getLastPolledMessageId(sessionId) || null;
    let submitted = false;
    let promptCompleted = false;

    try {
      logger.info('opencode sse connecting', { sessionId, sseUrl });
      const ssePromise = this.sseClient.connect(sseUrl, {
        idleTimeoutMs: this.sseIdleTimeoutMs || undefined,
        signal: controller.signal,
        onOpen: () => {
          logger.info('opencode sse opened', { sessionId, sseUrl });
          markSSEOpen();
        },
        onEvent: (raw) => {
          logger.info('opencode sse event received', {
            sessionId,
            type: raw && raw.type,
            status: raw && raw.properties && raw.properties.status && raw.properties.status.type,
            partType: raw && raw.properties && raw.properties.part && raw.properties.part.type,
          });
        },
        shouldClose: (raw) => isTerminalSSEEvent(raw, sessionId),
      });
      ssePromise.catch(() => {});

      let sseOpenedFlag = false;
      const sseOpenPromise = sseOpened.then(() => { sseOpenedFlag = true; }, () => {});

      if (this.sseOpenTimeoutMs > 0) {
        await Promise.race([
          sseOpenPromise,
          this._sleep(this.sseOpenTimeoutMs).then(() => {
            if (!sseOpenedFlag) {
              controller.abort();
              const err = new Error('SSE connection open timeout after ' + this.sseOpenTimeoutMs + 'ms');
              err.code = 'SSE_OPEN_TIMEOUT';
              throw err;
            }
          }),
        ]);
      } else {
        await sseOpenPromise;
      }

      logger.info('opencode prompt start', {
        sessionId,
        promptUrl,
        textLength: text ? text.length : 0,
      });

      const requestTimeoutMs = this.promptRequestTimeoutMs > 0 ? this.promptRequestTimeoutMs : undefined;
      const promptResp = await this.httpClient.request('POST', promptUrl, body, requestTimeoutMs ? { timeoutMs: requestTimeoutMs } : undefined);
      logger.info('opencode prompt posted', { sessionId, promptUrl, status: promptResp && promptResp.status });
      if (promptResp && promptResp.status && (promptResp.status < 200 || promptResp.status >= 300)) {
        throw new Error('opencode prompt failed with HTTP ' + promptResp.status);
      }
      submitted = true;

      try {
        const rawEvents = await ssePromise;
        for (const raw of rawEvents) {
          const event = mapSSEEvent(raw, sessionId);
          if (event) events.push(event);
          if (event && event.type === AgentEvent.TYPE_DONE) break;
        }
        promptCompleted = true;
        logger.info('opencode sse completed', { sessionId, eventCount: events.length });
      } catch (sseErr) {
        if (controller.signal.aborted && externalSignal && externalSignal.aborted) {
          throw sseErr;
        }
        logger.info('opencode sse interrupted after submit, entering recovery', { sessionId, error: sseErr.message });
        const recovered = await this._recoverFromDisconnection(sessionRef, sessionId, baselineId, controller.signal);
        if (recovered) {
          for (const event of recovered) events.push(event);
          promptCompleted = true;
          logger.info('opencode recovered from disconnection', { sessionId, eventCount: recovered.length });
        } else {
          throw sseErr;
        }
      }
    } catch (err) {
      // 防御性兜底：主要抛出点已设置 code，此处为无 code 的错误补 code
      if (!err.code && err.message && /open timeout/i.test(err.message)) {
        err.code = 'SSE_OPEN_TIMEOUT';
      } else if (!err.code && err.message && /timed out/i.test(err.message) && !submitted) {
        err.code = 'PROMPT_REQUEST_TIMEOUT';
      } else if (!err.code && err.message && /idle/i.test(err.message)) {
        err.code = 'SSE_IDLE_TIMEOUT';
      } else if (!err.code && controller.signal.aborted) {
        err.code = 'ABORT_ERR';
      }
      logger.warn('opencode prompt failed', { sessionId, error: err.message, code: err.code });
      throw err;
    } finally {
      if (promptCompleted && events.length > 0) {
        const lastDone = [...events].reverse().find((e) => e.type === AgentEvent.TYPE_DONE);
        if (lastDone) {
          try {
            const messages = await this.getSessionMessages(sessionRef, { access: 'watcher', limit: 20 });
            const completed = messages.filter((m) => {
              const role = m.info ? m.info.role : m.role;
              const completed = this._messageCompletedAt(m);
              return role === 'assistant' && completed;
            });
            if (completed.length > 0) {
              const lastCompleted = completed[completed.length - 1];
              const lastId = lastCompleted.info ? lastCompleted.info.id : lastCompleted.id;
              this._sessionWatcher.setLastPolledMessageId(sessionId, lastId);
            }
          } catch (e) {
            logger.debug('failed to update cursor after successful prompt', { sessionId, error: e.message });
          }
        }
      }
      if (externalSignal && onExternalAbort) {
        try { externalSignal.removeEventListener('abort', onExternalAbort); } catch (_) {}
      }
      this._sessionWatcher.resume(sessionRef);
    }

    return events;
  }

  async _recoverFromDisconnection(sessionRef, sessionId, baselineId, signal) {
    const pollIntervalMs = this._sessionWatcher.pollIntervalMs;
    const maxRecoveryMs = this.recoveryWindowMs;
    const startTime = Date.now();
    const events = [];

    while (Date.now() - startTime < maxRecoveryMs) {
      if (signal && signal.aborted) return null;
      try {
        const messages = await this.getSessionMessages(sessionRef, { access: 'watcher', limit: 20 });
        if (signal && signal.aborted) return null;
        const newCompleted = [];
        let foundBaseline = !baselineId;
        for (const m of messages) {
          const id = m.info ? m.info.id : m.id;
          if (!foundBaseline) {
            if (id === baselineId) foundBaseline = true;
            continue;
          }
          const role = m.info ? m.info.role : m.role;
          const completed = m.info && m.info.time && m.info.time.completed;
          if (role === 'assistant' && completed) {
            newCompleted.push(m);
          }
        }
        if (newCompleted.length > 0) {
          const lastCompleted = newCompleted[newCompleted.length - 1];
          for (const msg of newCompleted) {
            const parts = msg.parts || [];
            for (const part of parts) {
              if (part.type === 'text' && part.text) {
                events.push(new AgentEvent(AgentEvent.TYPE_TEXT, { text: part.text }));
              }
            }
          }
          events.push(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'recovered' }));
          const lastId = lastCompleted.info ? lastCompleted.info.id : lastCompleted.id;
          this._sessionWatcher.setLastPolledMessageId(sessionId, lastId);
          return events;
        }
      } catch (e) {
        logger.debug('recovery poll failed', { sessionId, error: e.message });
      }
      await this._sleep(pollIntervalMs);
    }
    logger.warn('recovery polling timed out', { sessionId });
    return null;
  }

  watchSession(sessionRef, handlers, options) {
    if (this._isTuiBridge(sessionRef)) return this.tuiBridge.watchSession(sessionRef, handlers);
    return this._sessionWatcher.watch(sessionRef, handlers, options);
  }

  suspendWatch(sessionRef) {
    if (this._isTuiBridge(sessionRef)) return;
    this._sessionWatcher.suspend(sessionRef);
  }

  resumeWatch(sessionRef) {
    if (this._isTuiBridge(sessionRef)) return;
    this._sessionWatcher.resume(sessionRef);
  }

  async getSessionMessages(sessionRef, options) {
    if (!sessionRef || !sessionRef.opencodeSessionId) {
      throw new Error('getSessionMessages requires sessionRef with opencodeSessionId');
    }
    if (this._isTuiBridge(sessionRef)) return [];
    if (options && options.access === 'watcher') {
      return this._getSessionMessagesForWatcher(sessionRef, options);
    }
    return this._getSessionMessagesHttp(sessionRef);
  }

  async stop(sessionRef) {
    if (!sessionRef || !sessionRef.opencodeSessionId) {
      throw new Error('stop requires sessionRef with opencodeSessionId');
    }
    if (this._isTuiBridge(sessionRef)) return this.tuiBridge.stop(sessionRef);
    const url = this._buildUrl('/session/' + encodeURIComponent(sessionRef.opencodeSessionId) + '/stop', {}, sessionRef);
    try {
      await this.httpClient.request('POST', url, {});
      logger.info('opencode session stopped', { sessionId: sessionRef.opencodeSessionId });
    } catch (err) {
      logger.warn('opencode session stop failed', { error: err.message });
    }
  }

  async cancel(sessionRef) {
    if (!sessionRef || !sessionRef.opencodeSessionId) {
      throw new Error('cancel requires sessionRef with opencodeSessionId');
    }
    if (this._isTuiBridge(sessionRef)) return this.tuiBridge.cancel(sessionRef);
    const sessionId = sessionRef.opencodeSessionId;
    if (this._sessionWatcher.hasActiveWatch(sessionId)) {
      this._sessionWatcher.stopWatch(sessionId);
      logger.info('opencode session prompt cancelled', { sessionId });
    } else {
      logger.info('opencode session cancel: no active prompt to cancel', { sessionId });
    }
  }

  async delete(sessionRef) {
    if (!sessionRef || !sessionRef.opencodeSessionId) {
      throw new Error('delete requires sessionRef with opencodeSessionId');
    }
    if (this._isTuiBridge(sessionRef)) return this.tuiBridge.delete(sessionRef);
    const url = this._buildUrl('/session/' + encodeURIComponent(sessionRef.opencodeSessionId), {}, sessionRef);
    try {
      await this.httpClient.request('DELETE', url, null);
      logger.info('opencode session deleted', { sessionId: sessionRef.opencodeSessionId });
    } catch (err) {
      logger.warn('opencode session delete failed', { error: err.message });
    }
  }

  async replyPermission(sessionRef, permissionId, response, remember) {
    if (!sessionRef || !sessionRef.opencodeSessionId) {
      throw new Error('replyPermission requires sessionRef with opencodeSessionId');
    }
    if (!permissionId) {
      throw new Error('replyPermission requires permissionId');
    }
    if (this._isTuiBridge(sessionRef)) {
      if (!sessionRef.runtimeId) {
        throw new Error('replyPermission requires tui-bridge sessionRef with runtimeId');
      }
      if (!this.tuiBridge || typeof this.tuiBridge.replyPermission !== 'function') {
        throw new Error('replyPermission requires configured tuiBridge with replyPermission');
      }
      return this.tuiBridge.replyPermission(sessionRef, permissionId, response, remember);
    }
    const url = this._buildUrl(
      '/session/' + encodeURIComponent(sessionRef.opencodeSessionId) + '/permissions/' + encodeURIComponent(permissionId),
      {},
      sessionRef,
    );
    const body = { response: response, remember: remember !== undefined ? remember : false };
    try {
      await this.httpClient.request('POST', url, body);
      logger.info('opencode permission replied', { sessionId: sessionRef.opencodeSessionId, permissionId, response });
    } catch (err) {
      logger.warn('opencode permission reply failed', { error: err.message, permissionId });
      throw err;
    }
  }

  /**
   * 通过 protocol v4+ TUI Bridge 回复原生 question，不降级为 permission 或 prompt。
   */
  async replyQuestion(agentRef, requestID, answers) {
    if (!agentRef || agentRef.transport !== 'tui-bridge') {
      throw questionReplyError(
        'native question replies require a tui-bridge agentRef',
        'QUESTION_REPLY_UNSUPPORTED',
      );
    }
    if (!agentRef.runtimeId || !agentRef.opencodeSessionId) {
      throw questionReplyError(
        'native question replies require tui-bridge agentRef with runtimeId and opencodeSessionId',
        'TUI_INVALID_SESSION_REF',
      );
    }
    if (!this.tuiBridge || typeof this.tuiBridge.replyQuestion !== 'function') {
      throw questionReplyError(
        'native question replies require configured tuiBridge with replyQuestion',
        'QUESTION_REPLY_UNSUPPORTED',
      );
    }
    return this.tuiBridge.replyQuestion(agentRef, requestID, answers);
  }

  async clearSession(sessionRef) {
    if (!sessionRef || !sessionRef.opencodeSessionId) {
      throw new Error('clearSession requires sessionRef with opencodeSessionId');
    }
    if (!this._isTuiBridge(sessionRef)) {
      throw new Error('clearSession only supports tui-bridge transport');
    }
    if (!this.tuiBridge || typeof this.tuiBridge.clearSession !== 'function') {
      throw new Error('OpencodeDriver clearSession requires configured tuiBridge');
    }
    return this.tuiBridge.clearSession(sessionRef);
  }

  hasClearPending(sessionRef) {
    if (!this._isTuiBridge(sessionRef) || !this.tuiBridge) return false;
    if (typeof this.tuiBridge.hasClearPending !== 'function') return false;
    return this.tuiBridge.hasClearPending(sessionRef);
  }

  /**
   * 检查 agentRef 是否仍然可用（TUI bridge session 时 runtime 仍在线；HTTP session 总是可用）
   * @param {Object} agentRef - Agent 引用对象
   * @returns {boolean}
   */
  isSessionRefActive(agentRef) {
    if (!agentRef) return false;
    if (agentRef.transport !== 'tui-bridge') return true;
    if (!this.tuiBridge || typeof this.tuiBridge.isSessionRefActive !== 'function') return false;
    return this.tuiBridge.isSessionRefActive(agentRef);
  }

  async _checkHealth() {
    try {
      const resp = await this.httpClient.request('GET', this._buildUrl('/api/health', {}), null);
      if (resp.status === 200) return true;
      if (resp.status >= 500) {
        logger.warn('opencode server unhealthy but running', { status: resp.status });
        return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  _startServer() {
    if (!this.runtime) {
      throw new Error('runtime not configured for autostart');
    }
    const port = this._extractPort();
    const args = ['serve', '--hostname', '127.0.0.1', '--port', String(port)];
    const proc = this.runtime.spawn(this.opencodeCmd, args, { detached: true, stdio: 'ignore' });
    if (proc && proc.unref) proc.unref();
    logger.info('opencode server process spawned', { pid: proc ? proc.pid : null });
  }

  _extractPort() {
    const match = this.serverUrl.match(/:(\d+)/);
    return match ? parseInt(match[1], 10) : 4096;
  }

  _buildUrl(pathname, query, sessionRef) {
    const serverUrl = (sessionRef && sessionRef.serverUrl) || this.serverUrl;
    return buildUrl(serverUrl, pathname, query);
  }

  _isTuiBridge(sessionRef) {
    return !!(sessionRef && sessionRef.transport === 'tui-bridge' && this.tuiBridge);
  }

  _extractModelList(resp) { return extractModelList(resp); }

  _extractSessionList(resp) { return extractSessionList(resp); }

  _extractMessageList(resp) { return extractMessageList(resp); }

  _extractProjectList(resp) { return extractProjectList(resp); }

  _normalizeSessionSummary(raw, fallbackCwd) { return normalizeSessionSummary(raw, fallbackCwd); }

  async _openTerminalForSession(sessionId, cwd) {
    if (!this.runtime || typeof this.runtime.openTerminal !== 'function') {
      logger.info('runtime does not support openTerminal, skipping');
      return;
    }

    const args = ['attach', this.serverUrl, '-s', sessionId];
    if (cwd) args.push('--dir', cwd);

    try {
      await this.runtime.openTerminal(this.opencodeCmd, args, {
        cwd: cwd || process.cwd(),
        title: 'opencode ' + (sessionId ? sessionId.slice(0, 12) : 'session'),
      });
      logger.info('terminal window opened for session', { sessionId });
    } catch (err) {
      logger.warn('failed to open terminal window', { error: err.message });
    }
  }

  _summarizeResponse(resp) { return summarizeResponse(resp); }

  async _listSessionsForDirectory(cwd) {
    const url = this._buildUrl('/session', { directory: cwd });
    try {
      const resp = await this.httpClient.request('GET', url, null);
      const sessions = this._extractSessionList(resp)
        .map((session) => this._normalizeSessionSummary(session, cwd))
        .filter((session) => session.id);
      sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return sessions;
    } catch (err) {
      throw new Error('Failed to list opencode sessions at ' + this.serverUrl + ': ' + err.message);
    }
  }

  async _listAllSessions(extraCwds) {
    try {
      const projectUrl = this._buildUrl('/project', {});
      const projectResp = await this.httpClient.request('GET', projectUrl, null);
      const projects = this._extractProjectList(projectResp);
      const directories = projects
        .map((p) => p.worktree || p.path || p.directory)
        .filter((d) => d && d !== '/');
      const extra = (Array.isArray(extraCwds) ? extraCwds : [])
        .filter((d) => d && directories.indexOf(d) === -1);
      const allDirectories = directories.concat(extra);
      const results = await Promise.all(
        allDirectories.map((dir) =>
          this._listSessionsForDirectory(dir).catch(() => []),
        ),
      );
      const seen = new Set();
      const sessions = results.flat().filter((session) => {
        if (!session || !session.id || seen.has(session.id)) return false;
        seen.add(session.id);
        return true;
      });
      sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return sessions;
    } catch (_) {
      return this._listSessionsForDirectory(process.cwd());
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { OpencodeDriver };

function questionReplyError(message, code) {
  return Object.assign(new Error(message), {
    code,
    deliveryPhase: 'preflight',
    sdkInvoked: false,
    safeToRetry: false,
  });
}
