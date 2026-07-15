/** 进度卡片最大事件行数 */
const MAX_EVENT_LINES = 20;
/** 单条事件文本最大长度 */
const MAX_TEXT_LEN = 200;

/**
 * 截断超长文本，超出部分以省略号代替
 * @param {string} text - 原始文本
 * @param {number} [maxLen=MAX_TEXT_LEN] - 最大长度限制
 * @returns {string} 截断后的文本
 */
function truncateText(text, maxLen) {
  if (!maxLen) maxLen = MAX_TEXT_LEN;
  if (!text || text.length <= maxLen) return text || '';
  return text.slice(0, maxLen) + '...';
}

/**
 * 将 Agent 事件格式化为飞书卡片中显示的 Markdown 文本行
 * @param {AgentEvent} event - Agent 事件对象
 * @returns {string} 格式化后的显示文本，空事件返回空字符串
 */
function formatAgentEvent(event) {
  const d = event.data || {};
  const text = d.text || event.text;
  const name = d.name || event.name;
  const status = d.status || event.status;
  const error = d.error || event.error;
  const message = d.message || event.message;
  switch (event.type) {
    case 'text':
      return '';
    case 'reasoning':
      return '🤔 ' + truncateText(text, MAX_TEXT_LEN);
    case 'tool_use':
      return '🔧 ' + name + (status === 'done' ? ' ✓' : status === 'error' ? ' ✗' : ' ⏳');
    case 'error':
      const errMsg = error ? (error.message || error) : 'unknown error';
      return '❌ ' + truncateText(errMsg, MAX_TEXT_LEN);
    case 'status':
      return message ? truncateText(message, MAX_TEXT_LEN) : '';
    case 'done':
      return '';
    default:
      return '';
  }
}

/** 进度卡片阶段对应的飞书卡片标题颜色模板 */
const CARD_PHASE = {
  thinking: 'turquoise',
  working: 'blue',
  done: 'green',
  error: 'red',
};

/**
 * 进度卡片，追踪 Agent 处理过程并渲染为飞书交互卡片 JSON 结构
 */
class ProgressCard {
  /**
   * 初始化进度卡片
   * @param {Object} options - 初始化选项
   * @param {string} options.sessionId - 会话 ID
   * @param {string} [options.cardMessageId] - 已发送的卡片消息 ID
   */
  constructor({ sessionId, cardMessageId }) {
    this.sessionId = sessionId;
    this.cardMessageId = cardMessageId || null;
    this.phase = 'thinking';
    this.entries = [];
    this.entryTypes = [];
    this.done = false;
  }

  /**
   * 追加一个 Agent 事件到进度卡片，自动更新阶段状态
   * @param {AgentEvent} event - Agent 事件对象
   */
  append(event) {
    if (this.done) return;
    if (event.type === 'done') {
      this.markDone();
      return;
    }
    const formatted = formatAgentEvent(event);
    if (event.type === 'text') {
      this._updatePhase(event);
      return;
    }
    if (!formatted) return;
    this.entries.push(formatted);
    this.entryTypes.push(event.type);
    if (this.entries.length > MAX_EVENT_LINES) {
      this.entries = this.entries.slice(-MAX_EVENT_LINES);
      this.entryTypes = this.entryTypes.slice(-MAX_EVENT_LINES);
    }
    this._updatePhase(event);
  }

  /**
   * 标记进度卡片为已完成状态
   */
  markDone() {
    this.done = true;
    this.phase = 'done';
  }

  /**
   * 内部方法：根据事件类型更新卡片阶段状态
   * @param {AgentEvent} event - Agent 事件对象
   */
  _updatePhase(event) {
    if (event.type === 'error') {
      this.phase = 'error';
      return;
    }
    if (event.type === 'text' || event.type === 'tool_use' || event.type === 'reasoning') {
      if (this.phase === 'thinking') {
        this.phase = 'working';
      }
    }
  }

  /**
   * 渲染当前进度为飞书交互卡片 JSON 结构
   * @returns {Object} 飞书卡片 JSON 结构
   */
  render() {
    const headerTitle = this.done ? '完成' : this.phase === 'thinking' ? '思考中...' : this.phase === 'error' ? '出错' : '处理中';
    const elements = [];

    for (const entry of this.entries) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: entry },
      });
    }

    if (this.done) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '✅ 处理完成' },
      });
    }

    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: { title: { tag: 'plain_text', content: headerTitle }, template: CARD_PHASE[this.phase] },
      elements,
    };
  }

  /**
   * 获取卡片消息 ID
   * @returns {string|null} 卡片消息 ID
   */
  getCardId() {
    return this.cardMessageId;
  }

  /**
   * 处理卡片更新失败，返回重新发送新消息的策略
   * @returns {Object} 失败处理策略对象 { strategy: 'new_message' }
   */
  handlePatchFailure() {
    return { strategy: 'new_message' };
  }
}

module.exports = { ProgressCard, formatAgentEvent, truncateText, CARD_PHASE, MAX_EVENT_LINES, MAX_TEXT_LEN };
