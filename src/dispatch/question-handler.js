'use strict';

const { buildNativeQuestionCard, buildNativeQuestionStatusCard } = require('../platform/feishu/cards');
const { createLogger } = require('../core/logger');

const logger = createLogger('question-handler');
const TERMINAL_STATUSES = new Set(['replied', 'rejected', 'processed_unknown', 'feishu_unavailable']);
const EXPLICIT_TERMINALS = new Set(['replied', 'rejected']);
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_TERMINAL_REQUESTS = 1000;

/** 原生问题状态机，独占飞书卡片和整组答案提交。 */
class QuestionHandler {
  constructor({ feishuApi, sessionService, driverRegistry, now }) {
    this.feishuApi = feishuApi;
    this.sessionService = sessionService;
    this.driverRegistry = driverRegistry;
    this.now = now || (() => Date.now());
    this.requests = new Map();
  }

  /** 生成请求状态键，序列化 agentRef 并拼接 requestID。 */
  _key(agentRef, requestID) {
    return JSON.stringify(agentRef || {}) + ':' + String(requestID || '');
  }

  /** 组装飞书卡片 builder 所需的上下文选项。 */
  _requestOptions(request, index, status) {
    return {
      requestID: request.requestID,
      questionIndex: index,
      questionCount: request.questions.length,
      question: request.questions[index],
      selectedValues: request.selections ? request.selections[index] : [],
      answers: request.answers ? request.answers[index] : null,
      walkerSessionId: request.walkerSessionId,
      routeKey: request.routeKey,
      status,
    };
  }

  /** 切换为终态并记录完成时间，随后清理过期请求。 */
  _terminal(request, status) {
    request.status = status;
    request.completedAt = this.now();
    this.pruneStates();
  }

  /** 清理 24 小时外终态并按完成时间淘汰超过 1000 条的最早记录。 */
  pruneStates() {
    const now = this.now();
    const terminal = [];
    for (const [key, request] of this.requests) {
      if (!TERMINAL_STATUSES.has(request.status)) continue;
      if (request.completedAt != null && now - request.completedAt >= RETENTION_MS) {
        this.requests.delete(key);
      } else {
        terminal.push([key, request]);
      }
    }
    terminal.sort((a, b) => (a[1].completedAt || 0) - (b[1].completedAt || 0));
    while (terminal.length > MAX_TERMINAL_REQUESTS) this.requests.delete(terminal.shift()[0]);
  }

  /** 同一请求复用发送任务，避免重复 asked 并发发送相同卡片。 */
  async handleAsked(session, chatId, routeKey, agentEvent) {
    this.pruneStates();
    const data = agentEvent && agentEvent.data;
    if (!data || !data.requestID || !data.sessionID || !Array.isArray(data.questions) || data.questions.length === 0 || !session || !session.agentRef) {
      logger.warn('invalid native question asked event');
      return { error: 'invalid_request' };
    }
    const key = this._key(session.agentRef, data.requestID);
    let request = this.requests.get(key);
    if (!request) {
      request = {
        agentRef: session.agentRef,
        agent: session.agent,
        requestID: data.requestID,
        sessionID: data.sessionID,
        routeKey,
        chatId,
        walkerSessionId: session.id,
        questions: data.questions,
        answers: Array(data.questions.length).fill(null),
        selections: Array.from({ length: data.questions.length }, () => []),
        cards: Array(data.questions.length).fill(null),
        cardStates: Array(data.questions.length).fill('pending'),
        cardAttempts: Array(data.questions.length).fill(0),
        status: 'sending_cards',
        submitError: null,
        completedAt: null,
      };
      this.requests.set(key, request);
    }
    if (request.sendPromise) return request.sendPromise;
    if (request.status !== 'sending_cards') return { status: request.status };
    request.sendPromise = this._sendCards(request);
    try {
      return await request.sendPromise;
    } finally {
      request.sendPromise = null;
    }
  }

  /** 发送 asked 事件中的全部卡片，每题只直接尝试两次。 */
  async _sendCards(request) {
    for (let index = 0; index < request.questions.length; index++) {
      if (request.status !== 'sending_cards') return { status: request.status };
      const question = request.questions[index] || {};
      if ((!Array.isArray(question.options) || question.options.length === 0) && question.custom === false) {
        request.cardStates[index] = 'send_failed';
        this._terminal(request, 'feishu_unavailable');
        await this._patchAll(request, 'feishu_unavailable');
        return { status: request.status };
      }
      if (request.cards[index] || request.cardAttempts[index] >= 2) continue;
      request.cardStates[index] = 'sending';
      let sent = false;
      while (!sent && request.cardAttempts[index] < 2) {
        request.cardAttempts[index]++;
        try {
          const cardId = await this.feishuApi.replyCard({ chatId: request.chatId }, buildNativeQuestionCard(this._requestOptions(request, index)));
          if (!cardId) throw new Error('feishu replyCard returned no message id');
          request.cards[index] = cardId;
          request.cardStates[index] = 'sent';
          if (request.status !== 'sending_cards') {
            await this._patchOne(request, index, request.status);
            return { status: request.status };
          }
          sent = true;
        } catch (err) {
          logger.warn('native question card send failed', { requestID: request.requestID, index, attempt: request.cardAttempts[index], error: err && err.message, code: err && err.code, status: err && err.status, response: err && err.response });
          if (request.status !== 'sending_cards') return { status: request.status };
        }
      }
      if (request.status !== 'sending_cards') return { status: request.status };
      if (!sent) {
        request.cardStates[index] = 'send_failed';
        this._terminal(request, 'feishu_unavailable');
        await this._patchAll(request, 'feishu_unavailable');
        return { status: request.status };
      }
    }
    if (request.status !== 'sending_cards') return { status: request.status };
    request.status = 'collecting';
    return { status: request.status };
  }

  /** 解析 questionKey 为 requestID 和题目序号。 */
  _parseQuestionKey(questionKey) {
    const separator = String(questionKey || '').lastIndexOf(':');
    if (separator < 1) return null;
    const requestID = questionKey.slice(0, separator);
    const index = Number(questionKey.slice(separator + 1));
    return Number.isInteger(index) && index >= 0 ? { requestID, index } : null;
  }

  /** patch 飞书卡片，失败时降级向原会话发送一次文本（同一请求同一卡片只降级一次）。 */
  async _patch(cardId, card, chatId, text, request, index) {
    if (!cardId || !this.feishuApi || typeof this.feishuApi.patchCard !== 'function') return;
    try {
      await this.feishuApi.patchCard(cardId, card);
    } catch (err) {
      logger.warn('native question card patch failed', { cardId, error: err && err.message });
      if (chatId && typeof this.feishuApi.sendText === 'function' && request) {
        const fallbackKey = cardId + ':' + index;
        if (!request.patchFallbackSent) request.patchFallbackSent = new Set();
        if (request.patchFallbackSent.has(fallbackKey)) return;
        request.patchFallbackSent.add(fallbackKey);
        try { await this.feishuApi.sendText(chatId, text); } catch (_) {}
      }
    }
  }

  /** patch 单题卡片为指定状态。 */
  async _patchOne(request, index, status) {
    const card = buildNativeQuestionStatusCard(this._requestOptions(request, index, status));
    let fallbackText = '';
    if (card.body) {
      const md = card.body.elements.find((el) => el && el.tag === 'markdown');
      fallbackText = (md && typeof md.content === 'string') ? md.content : '';
    } else if (card.elements && card.elements[0] && card.elements[0].text) {
      fallbackText = card.elements[0].text.content || '';
    }
    return this._patch(request.cards[index], card, request.chatId, fallbackText, request, index);
  }

  /** 并行 patch 全部已发送卡片为指定状态。 */
  async _patchAll(request, status) {
    await Promise.all(request.cards.map((cardId, index) => cardId ? this._patchOne(request, index, status) : undefined));
  }

  /** 解析表单值为题目答案数组，非法时返回 null。 */
  _parseAnswers(question, formValue) {
    const selectedInput = formValue && formValue.question_selected;
    const custom = String((formValue && formValue.question_custom) || '').trim();
    const options = Array.isArray(question.options) ? question.options : [];
    const selected = Array.isArray(selectedInput) ? selectedInput : selectedInput == null || selectedInput === '' ? [] : [selectedInput];
    const selectedIndexes = new Set();
    for (const value of selected) {
      const match = /^option_(\d+)$/.exec(String(value));
      if (!match || !options[Number(match[1])]) return null;
      selectedIndexes.add(Number(match[1]));
    }
    if (question.multiple !== true && selectedIndexes.size > 1) return null;
    if (question.multiple !== true && selectedIndexes.size && custom) return null;
    if (custom && question.custom === false) return null;
    const answers = options.filter((_, index) => selectedIndexes.has(index)).map((option) => String(option.label || ''));
    if (custom) answers.push(custom);
    return answers.length ? answers : null;
  }

  /** 解析按钮协议里的选项值为答案数组，非法时返回 null。 */
  _parseOptionAnswers(question, values) {
    const options = Array.isArray(question.options) ? question.options : [];
    const selected = Array.isArray(values) ? values : values == null || values === '' ? [] : [values];
    const selectedIndexes = new Set();
    for (const value of selected) {
      const match = /^option_(\d+)$/.exec(String(value));
      if (!match || !options[Number(match[1])]) return null;
      selectedIndexes.add(Number(match[1]));
    }
    if (question.multiple !== true && selectedIndexes.size > 1) return null;
    const answers = [];
    options.forEach((option, index) => {
      if (selectedIndexes.has(index)) answers.push(String(option.label || option.value || 'option_' + index));
    });
    return answers.length ? answers : null;
  }

  /** 解析 checker 表单提交的布尔字段为按钮协议选项值。 */
  _parseCheckerAnswers(question, formValue) {
    if (!formValue || typeof formValue !== 'object') return null;
    const selected = [];
    for (const [key, value] of Object.entries(formValue)) {
      const match = /^question_selected_(\d+)$/.exec(key);
      if (!match || (value !== true && value !== 'true' && value !== 1)) continue;
      selected.push('option_' + match[1]);
    }
    const answers = this._parseOptionAnswers(question, selected) || [];
    const custom = String(formValue.question_custom || '').trim();
    if (question.multiple !== true && answers.length > 1) return null;
    if (question.multiple !== true && answers.length && custom) return null;
    if (question.multiple !== true && selected.length && custom) return null;
    if (custom) {
      if (question.custom === false) return null;
      answers.push(custom);
    }
    return answers.length ? answers : null;
  }

  /** 更新仍在收集中的原生问题卡片，例如多选按钮切换后的高亮状态。 */
  async _patchQuestionCard(request, index) {
    const card = buildNativeQuestionCard(this._requestOptions(request, index));
    let fallbackText = '';
    if (card.body) {
      const md = card.body.elements.find((el) => el && el.tag === 'markdown');
      fallbackText = (md && typeof md.content === 'string') ? md.content : '';
    } else if (card.elements && card.elements[0] && card.elements[0].text) {
      fallbackText = card.elements[0].text.content || '';
    }
    return this._patch(request.cards[index], card, request.chatId, fallbackText, request, index);
  }

  /** 记录答案，并在全部题目齐备后提交到 OpenCode 原生 question。 */
  async _acceptAnswers(request, index, answers) {
    logger.info('native question answer accepted', { requestID: request.requestID, index, answers });
    request.answers[index] = answers;
    request.cardStates[index] = 'answered';
    if (!request.answers.every((answer) => Array.isArray(answer) && answer.length)) {
      await this._patchOne(request, index, 'answered');
      return { status: 'collecting' };
    }
    request.status = 'submitting';
    request.submitError = null;
    await this._patchAll(request, 'submitting');
    if (request.status !== 'submitting') return { status: request.status };
    return this.submitAnswers(request);
  }

  /** 对找不到请求或上下文不匹配的回调 patch 过期状态。 */
  async _expired(cmd, parsed) {
    if (!cmd.messageId) return;
    const card = buildNativeQuestionStatusCard({ requestID: parsed ? parsed.requestID : '', questionIndex: parsed ? parsed.index : 0, status: 'expired' });
    await this._patch(cmd.messageId, card, cmd.chatId, '请求已过期');
  }

  /** 验证原卡片上下文后收集单题答案或重试整组提交。 */
  async handleAnswer(cmd) {
    this.pruneStates();
    const args = cmd.args || [];
    const parsed = this._parseQuestionKey(args[0]);
    const mode = args[1];
    const optionValue = mode === '--option' || mode === '--toggle' ? args[2] : null;
    const walkerSessionId = mode === '--option' || mode === '--toggle' ? args[3] : args[2];
    const validCommand = parsed && (
      ((mode === '--form' || mode === '--retry' || mode === '--submit') && walkerSessionId && args.length === 3)
      || ((mode === '--option' || mode === '--toggle') && optionValue && walkerSessionId && args.length === 4)
    );
    if (!validCommand) {
      logger.warn('native question answer rejected: invalid command', { args, messageId: cmd.messageId, routeKey: cmd.routeKey });
      return { error: 'invalid_answer_command' };
    }
    const session = this.sessionService && typeof this.sessionService.getSession === 'function' ? this.sessionService.getSession(walkerSessionId) : null;
    if (!session || !session.agentRef) {
      logger.warn('native question answer rejected: session expired', { requestID: parsed.requestID, index: parsed.index, walkerSessionId, messageId: cmd.messageId });
      await this._expired(cmd, parsed);
      return { error: 'expired' };
    }
    const request = this.requests.get(this._key(session.agentRef, parsed.requestID));
    if (!request) {
      logger.warn('native question answer rejected: request expired', { requestID: parsed.requestID, index: parsed.index, walkerSessionId, messageId: cmd.messageId });
      await this._expired(cmd, parsed);
      return { error: 'expired' };
    }
    if (request.walkerSessionId !== walkerSessionId || request.routeKey !== cmd.routeKey || request.cards[parsed.index] !== cmd.messageId) {
      logger.warn('native question answer rejected: callback mismatch', { requestID: parsed.requestID, index: parsed.index, walkerSessionId, expectedWalkerSessionId: request.walkerSessionId, routeKey: cmd.routeKey, expectedRouteKey: request.routeKey, messageId: cmd.messageId, expectedMessageId: request.cards[parsed.index] });
      await this._patchOne(request, parsed.index, 'expired');
      return { error: 'invalid_callback' };
    }
    if (parsed.index >= request.questions.length) {
      logger.warn('native question answer rejected: question index out of range', { requestID: parsed.requestID, index: parsed.index, questionCount: request.questions.length });
      return { error: 'invalid_callback' };
    }
    if (request.status === 'sending_cards') {
      await this._patchOne(request, parsed.index, 'preparing');
      return { status: 'sending_cards' };
    }
    if (request.status === 'submitting') {
      await this._patchOne(request, parsed.index, 'submitting');
      return { status: 'submitting' };
    }
    if (TERMINAL_STATUSES.has(request.status)) {
      await this._patchOne(request, parsed.index, request.status);
      return { status: request.status };
    }
    if (mode === '--retry') {
      if (!request.answers.every((answer) => Array.isArray(answer) && answer.length)) {
        logger.warn('native question retry rejected: answers not ready', { requestID: request.requestID, answeredCount: request.answers.filter((answer) => Array.isArray(answer) && answer.length).length, questionCount: request.questions.length });
        return { error: 'not_ready' };
      }
      request.status = 'submitting';
      request.submitError = null;
      await this._patchAll(request, 'submitting');
      if (request.status !== 'submitting') return { status: request.status };
      return this.submitAnswers(request);
    }
    if (request.answers[parsed.index]) {
      await this._patchOne(request, parsed.index, 'answered');
      return { status: 'answered' };
    }

    const question = request.questions[parsed.index] || {};
    if (mode === '--toggle') {
      if (question.multiple !== true || !this._parseOptionAnswers(question, [optionValue])) {
        logger.warn('native question answer rejected: invalid option value', { requestID: request.requestID, index: parsed.index, optionValue });
        return { error: 'invalid_answer' };
      }
      const selected = new Set((request.selections && request.selections[parsed.index]) || []);
      if (selected.has(optionValue)) selected.delete(optionValue);
      else selected.add(optionValue);
      request.selections[parsed.index] = Array.from(selected);
      await this._patchQuestionCard(request, parsed.index);
      return { status: 'collecting', selected: request.selections[parsed.index] };
    }

    const answers = mode === '--form'
      ? this._parseAnswers(question, cmd.formValue)
      : mode === '--submit' && cmd.formValue
        ? this._parseCheckerAnswers(question, cmd.formValue)
        : this._parseOptionAnswers(question, mode === '--option' ? [optionValue] : (request.selections && request.selections[parsed.index]) || []);
    if (!answers) {
      logger.warn('native question answer rejected: invalid answer value', { requestID: request.requestID, index: parsed.index, mode, formValue: cmd.formValue || null, optionValue });
      return { error: 'invalid_answer' };
    }
    return this._acceptAnswers(request, parsed.index, answers);
  }

  /** 提交权只在 collecting 到 submitting 的同步转换中获取。 */
  async submitAnswers(request) {
    if (request.status !== 'submitting') return { status: request.status };
    const driver = this.driverRegistry && this.driverRegistry.get(request.agent);
    if (!driver || typeof driver.replyQuestion !== 'function') {
      this._terminal(request, 'processed_unknown');
      await this._patchAll(request, 'processed_unknown');
      return { status: request.status };
    }
    try {
      if (request.status !== 'submitting') return { status: request.status };
      await driver.replyQuestion(request.agentRef, request.requestID, request.answers);
      if (request.status !== 'submitting') return { status: request.status };
      this._terminal(request, 'replied');
      await this._patchAll(request, 'replied');
      return { status: request.status };
    } catch (err) {
      if (request.status !== 'submitting') return { status: request.status };
      if (err && err.code === 'QUESTION_REPLY_UNSUPPORTED') {
        this._terminal(request, 'feishu_unavailable');
        await this._patchAll(request, 'feishu_unavailable');
      } else if (err && err.safeToRetry === true && err.sdkInvoked === false) {
        request.status = 'collecting';
        request.submitError = err;
        await this._patchAll(request, 'retryable');
      } else {
        this._terminal(request, 'processed_unknown');
        await this._patchAll(request, 'processed_unknown');
      }
      return { status: request.status };
    }
  }

  /** 按 session 和 requestID 查找请求。 */
  _findRequest(session, requestID) {
    this.pruneStates();
    return session && session.agentRef ? this.requests.get(this._key(session.agentRef, requestID)) : null;
  }

  /** 处理原生 question.replied 事件，已显式终态时不覆盖。 */
  async handleReplied(session, _chatId, agentEvent) {
    const data = agentEvent && agentEvent.data;
    const request = this._findRequest(session, data && data.requestID);
    if (!request) return { error: 'not_found' };
    if (EXPLICIT_TERMINALS.has(request.status)) return { status: request.status };
    request.answers = Array.isArray(data.answers) ? data.answers : request.answers;
    this._terminal(request, 'replied');
    await this._patchAll(request, 'replied');
    return { status: request.status };
  }

  /** 处理原生 question.rejected 事件，已显式终态时不覆盖。 */
  async handleRejected(session, _chatId, agentEvent) {
    const data = agentEvent && agentEvent.data;
    const request = this._findRequest(session, data && data.requestID);
    if (!request) return { error: 'not_found' };
    if (EXPLICIT_TERMINALS.has(request.status)) return { status: request.status };
    this._terminal(request, 'rejected');
    await this._patchAll(request, 'rejected');
    return { status: request.status };
  }
}

module.exports = { QuestionHandler };
