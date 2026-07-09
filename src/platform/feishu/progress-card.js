const MAX_EVENT_LINES = 20;
const MAX_TEXT_LEN = 200;

function truncateText(text, maxLen) {
  if (!maxLen) maxLen = MAX_TEXT_LEN;
  if (!text || text.length <= maxLen) return text || '';
  return text.slice(0, maxLen) + '...';
}

function formatAgentEvent(event) {
  const d = event.data || {};
  const text = d.text || event.text;
  const name = d.name || event.name;
  const status = d.status || event.status;
  const error = d.error || event.error;
  const message = d.message || event.message;
  switch (event.type) {
    case 'text':
      return truncateText(text, MAX_TEXT_LEN);
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

const CARD_PHASE = {
  thinking: 'turquoise',
  working: 'blue',
  done: 'green',
  error: 'red',
};

class ProgressCard {
  constructor({ sessionId, cardMessageId }) {
    this.sessionId = sessionId;
    this.cardMessageId = cardMessageId || null;
    this.phase = 'thinking';
    this.entries = [];
    this.done = false;
  }

  append(event) {
    if (this.done) return;
    const formatted = formatAgentEvent(event);
    if (!formatted) return;
    this.entries.push(formatted);
    if (this.entries.length > MAX_EVENT_LINES) {
      this.entries = this.entries.slice(-MAX_EVENT_LINES);
    }
    this._updatePhase(event);
  }

  markDone() {
    this.done = true;
    this.phase = 'done';
  }

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

  render() {
    const headerTitle = this.done ? '完成' : this.phase === 'thinking' ? '思考中...' : this.phase === 'error' ? '出错' : '处理中';
    const elements = [];

    for (const entry of this.entries) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: entry },
      });
    }

    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: headerTitle }, template: CARD_PHASE[this.phase] },
      elements,
    };
  }

  getCardId() {
    return this.cardMessageId;
  }

  handlePatchFailure() {
    return { strategy: 'new_message' };
  }
}

module.exports = { ProgressCard, formatAgentEvent, truncateText, CARD_PHASE, MAX_EVENT_LINES, MAX_TEXT_LEN };
