'use strict';

const { AgentEvent } = require('../drivers/agent-driver');

/**
 * 进度渲染器，负责将 Agent 事件列表渲染为飞书进度卡片或纯文本回复，
 * 并提供模型引用的规范化辅助方法（供渲染和命令处理共用）。
 *
 * 共享状态（sessionDeliveredTexts / sessionWatchBuffers / sessionWatchProgressCards /
 * sessionWatchProgressPromises / turnStates 等）仍挂在 dispatcher 实例上，
 * 以保持向后兼容。
 */
class ProgressRenderer {
  /**
   * @param {Object} options
   * @param {Object} options.dispatcher - MessageDispatcher 实例
   * @param {Object} options.feishuApi - 飞书 API 代理
   * @param {string} [options.progressStyle] - 进度展示风格（card 或 text）
   * @param {string} [options.doneEmoji] - 完成表情符号
   * @param {boolean} [options.nonFocusOutput] - 是否输出非焦点 session 的结果
   * @param {Object|string} [options.defaultModel] - 默认模型
   */
  constructor({ dispatcher, feishuApi, progressStyle, doneEmoji, nonFocusOutput, defaultModel }) {
    this.dispatcher = dispatcher;
    this.feishuApi = feishuApi;
    this.progressStyle = progressStyle;
    this.doneEmoji = doneEmoji;
    this.nonFocusOutput = nonFocusOutput;
    this.defaultModel = defaultModel;
  }

  /**
   * 根据 progressStyle 选择渲染方式并渲染 Agent 事件列表
   * @param {Object} session - 当前会话对象
   * @param {Object} event - 原始消息事件
   * @param {AgentEvent[]} events - Agent 返回的事件列表
   * @param {string|null} progressCardId - 进度卡片消息 ID
   * @returns {Promise<void>}
   */
  async _renderEvents(session, event, events, progressCardId) {
    if (this.dispatcher._isTurnSuppressed(session.id)) return;
    const displayEvents = this._coalesceDisplayEvents(events, event.text);
    if (this.progressStyle === 'card') {
      await this._renderCardProgress(session, event, displayEvents, progressCardId);
      const fullText = this._textFromDisplayEvents(displayEvents);
      if (fullText) {
        const replyResult = await this.dispatcher._callFeishu('replyMarkdown', [this.dispatcher._replyCtx(event), this._appendModelFooter(fullText, session)], null);
        if (replyResult) {
          this.dispatcher._rememberDeliveredText(session.id, fullText);
        }
      }
    } else {
      await this._renderLegacyProgress(session, event, displayEvents);
      this.dispatcher._rememberDeliveredText(session.id, this._textFromDisplayEvents(displayEvents));
    }
  }

  /**
   * 使用飞书卡片消息渲染 Agent 处理进度，实时更新卡片内容
   * @param {Object} session - 当前会话对象
   * @param {Object} event - 原始消息事件
   * @param {AgentEvent[]} displayEvents - 已合并的显示事件列表
   * @param {string|null} progressCardId - 进度卡片消息 ID
   * @returns {Promise<void>}
   */
  async _renderCardProgress(session, event, displayEvents, progressCardId) {
    let cardId = progressCardId || await this.dispatcher._callFeishu('sendProgressCard', [this.dispatcher._replyCtx(event), session.id], null);

    if (!cardId) {
      return;
    }

    for (const agentEvent of displayEvents) {
      if (agentEvent.type === AgentEvent.TYPE_TEXT) continue;
      if (agentEvent.type === AgentEvent.TYPE_PERMISSION || agentEvent.type === AgentEvent.TYPE_PERMISSION_REPLIED) continue;
      if (agentEvent.type === AgentEvent.TYPE_MESSAGE_REMOVED || agentEvent.type === AgentEvent.TYPE_SESSION_LIFECYCLE || agentEvent.type === AgentEvent.TYPE_SERVER_CONNECTED) continue;
      if (agentEvent.type === AgentEvent.TYPE_STEP || agentEvent.type === AgentEvent.TYPE_SESSION_DIFF) continue;
      this.dispatcher._touchTurnState(this.dispatcher.turnStates.get(session.id));
      const rendered = await this.dispatcher._callFeishu('updateProgressCard', [cardId, session.id, agentEvent], null);
      if (rendered && rendered.strategy === 'new_message') {
        const newCardId = await this.dispatcher._callFeishu('sendProgressCard', [this.dispatcher._replyCtx(event), session.id, agentEvent], null);
        if (newCardId) cardId = newCardId;
      }
    }

    if (this.doneEmoji) {
      this.dispatcher._sendFeishu('addReaction', [event.messageId, this.doneEmoji]);
    }
  }

  /**
   * 合并 Agent 事件流中的增量文本事件，剥离 prompt 回显，生成最终显示事件列表
   * @param {AgentEvent[]} events - Agent 返回的原始事件列表
   * @param {string} promptText - 原始 prompt 文本，用于剥离回显
   * @returns {AgentEvent[]} 合并后的显示事件列表
   */
  _coalesceDisplayEvents(events, promptText) {
    const displayEvents = [];
    let textBuffer = '';

    const flushText = () => {
      if (!textBuffer) return;
      const text = this._stripPromptEcho(textBuffer, promptText);
      if (text) this._pushDisplayEvent(displayEvents, new AgentEvent(AgentEvent.TYPE_TEXT, { text }));
      textBuffer = '';
    };

    for (const agentEvent of events) {
      if (agentEvent.type === AgentEvent.TYPE_TEXT && agentEvent.data && agentEvent.data.delta) {
        textBuffer += agentEvent.data.text || '';
        continue;
      }
      flushText();
      if (agentEvent.type === AgentEvent.TYPE_TEXT) {
        const text = this._stripPromptEcho(agentEvent.data && agentEvent.data.text, promptText);
        if (text) this._pushDisplayEvent(displayEvents, new AgentEvent(AgentEvent.TYPE_TEXT, Object.assign({}, agentEvent.data, { text })));
        continue;
      }
      this._pushDisplayEvent(displayEvents, agentEvent);
    }

    flushText();
    return displayEvents;
  }

  /**
   * 将一个 Agent 事件推入显示列表，合并连续的增量文本事件
   * @param {AgentEvent[]} displayEvents - 显示事件列表
   * @param {AgentEvent} agentEvent - 待推入的事件
   */
  _pushDisplayEvent(displayEvents, agentEvent) {
    const previous = displayEvents[displayEvents.length - 1];
    if (previous && previous.type === AgentEvent.TYPE_TEXT && agentEvent.type === AgentEvent.TYPE_TEXT) {
      const previousText = previous.data && previous.data.text;
      const nextText = agentEvent.data && agentEvent.data.text;
      if (previousText === nextText) return;
      if (previousText && nextText && previousText.endsWith(nextText)) return;
      if (previousText && nextText && nextText.startsWith(previousText)) {
        const tail = nextText.slice(previousText.length).trimStart();
        const tailWithoutMessageId = tail.replace(/^m\d+\s*/i, '').trimStart();
        if (!tailWithoutMessageId || tailWithoutMessageId === previousText) return;
        previous.data = Object.assign({}, previous.data, { text: nextText });
        return;
      }
    }
    displayEvents.push(agentEvent);
  }

  /**
   * 剥离文本开头的 prompt 回显和消息 ID 前缀，合并编号快照
   * @param {string} text - 原始文本
   * @param {string} promptText - prompt 文本
   * @returns {string} 剥离后的文本
   */
  _stripPromptEcho(text, promptText) {
    if (!text) return '';
    const prompt = (promptText || '').trim();
    let output = text;
    if (prompt) {
      if (output === prompt) return '';
      if (output.startsWith(prompt)) output = output.slice(prompt.length).trimStart();
    }
    output = output.replace(/^m\d+\s*/i, '').trimStart();
    return this._collapseNumberedSnapshots(output);
  }

  /**
   * 合并以消息 ID 分隔的编号快照文本，去重并保留最终状态
   * @param {string} text - 含编号快照的文本
   * @returns {string} 合并后的文本
   */
  _collapseNumberedSnapshots(text) {
    if (!text) return '';
    const normalized = text.replace(/\r\n/g, '\n');
    const parts = normalized
      .split(/\n+\s*m\d+\s*\n+/i)
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length <= 1) return text;

    const snapshots = [];
    for (const part of parts) {
      this._pushTextSnapshot(snapshots, part);
    }
    return snapshots.join('\n\n');
  }

  /**
   * 将一段文本快照推入快照列表，合并连续增量
   * @param {string[]} snapshots - 快照列表
   * @param {string} nextText - 待推入的文本
   */
  _pushTextSnapshot(snapshots, nextText) {
    if (!nextText) return;
    const previous = snapshots[snapshots.length - 1];
    if (previous) {
      if (previous === nextText) return;
      if (previous.endsWith(nextText)) return;
      if (nextText.startsWith(previous)) {
        snapshots[snapshots.length - 1] = nextText;
        return;
      }
    }
    snapshots.push(nextText);
  }

  /**
   * 使用纯文本方式渲染 Agent 处理结果（仅输出文本事件内容）
   * @param {Object} session - 当前会话对象
   * @param {Object} event - 原始消息事件
   * @param {AgentEvent[]} displayEvents - 已合并的显示事件列表
   * @returns {Promise<void>}
   */
  async _renderLegacyProgress(session, event, displayEvents) {
    const fullText = this._textFromDisplayEvents(displayEvents);
    await this.dispatcher._callFeishu('replyMarkdown', [this.dispatcher._replyCtx(event), this._appendModelFooter(fullText.trim(), session)]);
  }

  /**
   * 从显示事件列表中提取所有文本事件内容并拼接
   * @param {AgentEvent[]} displayEvents - 显示事件列表
   * @returns {string} 拼接后的纯文本
   */
  _textFromDisplayEvents(displayEvents) {
    return (displayEvents || [])
      .filter((event) => event.type === AgentEvent.TYPE_TEXT)
      .map((event) => event.data && event.data.text)
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  /**
   * 为回复文本追加模型页脚
   * @param {string} text - 原始回复文本
   * @param {Object} session - 会话对象
   * @returns {string} 追加页脚后的文本
   */
  _appendModelFooter(text, session) {
    if (!text) return text;
    const model = this._formatModel(this._resolveSessionModel(session)) || '未指定';
    return text + '\n\n---\n模型：' + model;
  }

  /**
   * 格式化模型引用为可读字符串
   * @param {Object|string} model - 模型对象或字符串
   * @returns {string} 格式化后的模型描述
   */
  _formatModel(model) {
    if (!model) return '';
    if (typeof model === 'string') return model;
    if (model.providerID && model.modelID) return model.providerID + '/' + model.modelID;
    return model.modelID || '';
  }

  /**
   * 解析 defaultModel（可能是 string 或对象）为规范化对象
   * @returns {Object|null} - { providerID, modelID } 或 null
   */
  _normalizeDefaultModel() {
    const dm = this.defaultModel;
    if (!dm) return null;
    if (typeof dm === 'object') {
      return { providerID: dm.providerID || '', modelID: dm.modelID || '' };
    }
    const str = String(dm);
    if (str.includes('/')) {
      const parts = str.split('/');
      return { providerID: parts[0], modelID: parts.slice(1).join('/') };
    }
    return { providerID: '', modelID: str };
  }

  /**
   * 从 session.model 或 defaultModel 解析用于 prompt 的规范化模型对象
   * 兼容历史 string 类型 session.model，仅在读取边界规范化，不做持久化迁移
   * @param {Object} session - 会话对象
   * @returns {Object|null} - { providerID, modelID } 或 null
   */
  _resolveSessionModel(session) {
    if (session && session.model) {
      const m = session.model;
      if (typeof m === 'string') {
        if (m.includes('/')) {
          const parts = m.split('/');
          return { providerID: parts[0], modelID: parts.slice(1).join('/') };
        }
        return { providerID: '', modelID: m };
      }
      if (m && typeof m === 'object') {
        return { providerID: m.providerID || '', modelID: m.modelID || '' };
      }
    }
    return this._normalizeDefaultModel();
  }

  /**
   * /new 时解析继承模型：优先当前焦点 session.model，否则 defaultModel
   * @param {Object} current - 当前焦点 session
   * @returns {Object|null} - { providerID, modelID } 或 null
   */
  _resolveInheritedModel(current) {
    if (current && current.model) {
      return this._resolveSessionModel(current);
    }
    return this._normalizeDefaultModel();
  }

  /**
   * 根据输入和模型目录解析规范化模型引用
   * @param {string} input - 用户输入（可能是 modelID 或 provider/modelID）
   * @param {Array<Object>} models - driver.listModels() 返回的模型目录
   * @returns {Object} - { model: {providerID, modelID} } 或 { error: string }
   */
  _resolveModelRef(input, models) {
    const activeModels = (models || []).filter((m) => m && m.status !== 'deprecated' && m.enabled !== false);
    if (input.includes('/')) {
      const parts = input.split('/');
      const provider = parts[0];
      const id = parts.slice(1).join('/');
      const hit = activeModels.find((m) => m.provider === provider && m.id === id);
      if (!hit) {
        return { error: 'Model not found: ' + input + '. Use /model to list available models.' };
      }
      return { model: { providerID: provider, modelID: id } };
    }
    const matches = activeModels.filter((m) => m.id === input);
    if (matches.length === 0) {
      return { error: 'Model not found: ' + input + '. Use /model to list available models.' };
    }
    if (matches.length === 1) {
      return { model: { providerID: matches[0].provider || '', modelID: matches[0].id } };
    }
    const providers = Array.from(new Set(matches.map((m) => m.provider).filter(Boolean)));
    return {
      error: 'Multiple models match "' + input + '". Use provider/modelID, e.g. ' +
        providers.map((p) => p + '/' + input).join(' or ') + '.',
    };
  }

  /**
   * 格式化模型列表为纯文本展示
   * @param {Array<Object>} models - 模型列表
   * @returns {string} 格式化后的文本
   */
  _formatModelListText(models) {
    if (!models || models.length === 0) return 'No models available.';
    const active = models.filter((m) => m.status !== 'deprecated');
    if (active.length === 0) return 'No models available.';
    const grouped = {};
    for (const m of active) {
      const p = m.provider || 'unknown';
      if (!grouped[p]) grouped[p] = [];
      grouped[p].push(m);
    }
    const sections = [];
    for (const [provider, list] of Object.entries(grouped)) {
      sections.push('**' + provider + '**\n' + list.map((m) => '- `' + m.id + '` ' + m.name).join('\n'));
    }
    return '**可用模型**\n\n' + sections.join('\n\n') + '\n\n用法：/model <model_id> 或 /model <provider>/<model_id>';
  }
}

module.exports = { ProgressRenderer };
