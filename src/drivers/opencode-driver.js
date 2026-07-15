'use strict';

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
    this.promptTimeoutMs = options.promptTimeoutMs || 120000;
    this.sseOpenTimeoutMs = options.sseOpenTimeoutMs || 1000;
    this.tuiBridge = options.tuiBridge || null;

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
      const models = this._extractModelList(resp);
      return models.map((m) => ({
        id: m.id || m.modelID || '',
        name: m.name || m.modelName || '',
        provider: m.providerID || m.provider || '',
        status: m.status || '',
        enabled: m.enabled !== undefined ? m.enabled : true,
      })).filter((m) => m.id && m.enabled);
    } catch (err) {
      throw new Error('Failed to list models at ' + this.serverUrl + ': ' + err.message);
    }
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

    try {
      logger.info('opencode sse connecting', { sessionId, sseUrl });
      const controller = new AbortController();
      const ssePromise = this.sseClient.connect(sseUrl, {
        timeoutMs: this.promptTimeoutMs,
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

      await Promise.race([
        sseOpenPromise,
        this._sleep(this.sseOpenTimeoutMs).then(() => {
          if (!sseOpenedFlag) {
            controller.abort();
            throw new Error('SSE connection open timeout after ' + this.sseOpenTimeoutMs + 'ms');
          }
        }),
      ]);

      logger.info('opencode prompt start', {
        sessionId,
        promptUrl,
        textLength: text ? text.length : 0,
      });
      const promptResp = await this.httpClient.request('POST', promptUrl, body);
      logger.info('opencode prompt posted', { sessionId, promptUrl, status: promptResp && promptResp.status });
      if (promptResp && promptResp.status && (promptResp.status < 200 || promptResp.status >= 300)) {
        throw new Error('opencode prompt failed with HTTP ' + promptResp.status);
      }

      const rawEvents = await ssePromise;
      for (const raw of rawEvents) {
        const event = mapSSEEvent(raw, sessionId);
        if (event) events.push(event);
        if (event && event.type === AgentEvent.TYPE_DONE) break;
      }
      logger.info('opencode sse completed', { sessionId, eventCount: events.length });
    } catch (err) {
      logger.warn('opencode sse failed', { sessionId, error: err.message });
      throw err;
    } finally {
      if (this._sessionWatcher.hasLastPolledMessageId(sessionId)) {
        try {
          const messages = await this.getSessionMessages(sessionRef);
          if (messages.length > 0) {
            const last = messages[messages.length - 1];
            this._sessionWatcher.setLastPolledMessageId(sessionId, last.info ? last.info.id : last.id);
          }
        } catch (e) {
          logger.debug('failed to refresh last polled message after prompt', { sessionId, error: e.message });
        }
      }
      this._sessionWatcher.resume(sessionRef);
    }

    return events;
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
          this._listSessionsForDirectory(dir).catch(() => [])
        )
      );
      const sessions = results.flat();
      sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return sessions;
    } catch (err) {
      return this._listSessionsForDirectory(process.cwd());
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { OpencodeDriver };
