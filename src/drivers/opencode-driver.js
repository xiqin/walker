'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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
    this._hasModelStateOverride = Object.prototype.hasOwnProperty.call(options, 'modelState');
    this.modelState = options.modelState;
    const stateRoot = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    this.modelStatePath = options.modelStatePath || path.join(stateRoot, 'opencode', 'model.json');

    this._sessionWatcher = new OpencodeSessionWatcher({
      sseClient: this.sseClient,
      buildUrl: (path, query, sessionRef) => this._buildUrl(path, query, sessionRef),
      watchTimeoutMs: options.watchTimeoutMs || 300000,
      pollIntervalMs: options.messagePollIntervalMs || 3000,
      getSessionMessages: (ref) => this.getSessionMessages(ref),
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
    const url = this._buildUrl('/session', { directory: cwd });
    const body = {
      title: options.title || 'walker session',
    };
    if (options.model) body.model = options.model;
    if (options.agent) body.agent = options.agent;

    try {
      const resp = await this.httpClient.request('POST', url, body);
      const status = resp && resp.status;
      const responseSummary = this._summarizeResponse(resp);
      if (typeof status === 'number' && (status < 200 || status >= 300)) {
        throw new Error('HTTP ' + status + ' from ' + this.serverUrl + ': ' + responseSummary);
      }

      const sessionId = resp && (resp.id || resp.sessionID || resp.sessionId || (resp.data && (resp.data.id || resp.data.sessionID || resp.data.sessionId)));
      if (!sessionId) {
        throw new Error('missing session id from ' + this.serverUrl + ': ' + responseSummary);
      }
      logger.info('opencode session created', { opencodeSessionId: sessionId });

      await this._openTerminalForSession(sessionId, cwd);

      return {
        opencodeSessionId: sessionId,
        serverUrl: this.serverUrl,
        cwd,
      };
    } catch (err) {
      throw new Error('Failed to create opencode session at ' + this.serverUrl + ': ' + err.message);
    }
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

  async _loadModelState() {
    if (this._hasModelStateOverride) return this.modelState;
    try {
      const content = await fs.readFile(this.modelStatePath, 'utf8');
      return JSON.parse(content);
    } catch (_) {
      return null;
    }
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
    return this._listAllSessions();
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
            const messages = await this.getSessionMessages(sessionRef);
            const completed = messages.filter((m) => {
              const role = m.info ? m.info.role : m.role;
              const completed = m.info && m.info.time && m.info.time.completed;
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
        const messages = await this.getSessionMessages(sessionRef);
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

  watchSession(sessionRef, handlers) {
    if (this._isTuiBridge(sessionRef)) return this.tuiBridge.watchSession(sessionRef, handlers);
    return this._sessionWatcher.watch(sessionRef, handlers);
  }

  suspendWatch(sessionRef) {
    if (this._isTuiBridge(sessionRef)) return;
    this._sessionWatcher.suspend(sessionRef);
  }

  resumeWatch(sessionRef) {
    if (this._isTuiBridge(sessionRef)) return;
    this._sessionWatcher.resume(sessionRef);
  }

  async getSessionMessages(sessionRef) {
    if (!sessionRef || !sessionRef.opencodeSessionId) {
      throw new Error('getSessionMessages requires sessionRef with opencodeSessionId');
    }
    if (this._isTuiBridge(sessionRef)) return [];
    const sessionId = sessionRef.opencodeSessionId;
    const url = this._buildUrl('/session/' + sessionId + '/message', {}, sessionRef);
    const resp = await this.httpClient.request('GET', url);
    return this._extractMessageList(resp);
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

  async _checkHealth() {
    try {
      const resp = await this.httpClient.request('GET', this._buildUrl('/health', {}), null);
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

  async _listAllSessions() {
    try {
      const projectUrl = this._buildUrl('/project', {});
      const projectResp = await this.httpClient.request('GET', projectUrl, null);
      const projects = this._extractProjectList(projectResp);
      const directories = projects
        .map((p) => p.worktree || p.path || p.directory)
        .filter((d) => d && d !== '/');
      const results = await Promise.all(
        directories.map((dir) =>
          this._listSessionsForDirectory(dir).catch(() => []),
        ),
      );
      const sessions = results.flat();
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
