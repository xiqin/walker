'use strict';

const { AgentEvent } = require('./agent-driver');

function normalizeSSEEvent(raw) {
  if (raw && raw.payload && raw.payload.type) return raw.payload;
  return raw;
}

function eventBelongsToSession(props, sessionId) {
  if (!sessionId) return true;
  const eventSessionId = props.sessionID || props.sessionId || (props.session && props.session.id);
  return eventSessionId === sessionId;
}

function mapSSEEvent(raw, sessionId) {
  raw = normalizeSSEEvent(raw);
  if (!raw || !raw.properties) return null;
  const props = raw.properties;
  if (!eventBelongsToSession(props, sessionId)) return null;
  const type = raw.type;

  if (type === 'session.status') {
    const statusType = props.status && props.status.type;
    if (statusType === 'idle') {
      return new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' });
    }
    return new AgentEvent(AgentEvent.TYPE_STATUS, { status: statusType });
  }

  if (type === 'session.idle') {
    return new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' });
  }

  if (type === 'session.busy') {
    return new AgentEvent(AgentEvent.TYPE_STATUS, { status: 'busy' });
  }

  if (type === 'message.part.delta') {
    if (isUserMessageEvent(props)) return null;
    if (props.field === 'text' && props.delta) {
      return new AgentEvent(AgentEvent.TYPE_TEXT, { text: props.delta, delta: true });
    }
    return null;
  }

  if (type === 'message.updated' || type === 'message.part.updated') {
    if (isUserMessageEvent(props)) return null;
    const part = props.part;
    if (!part) return null;

    const text = part.text || part.content || part.value || '';
    if (part.type === 'text' && text) {
      return new AgentEvent(AgentEvent.TYPE_TEXT, { text });
    }
    if (part.type === 'reasoning' && text) {
      return new AgentEvent(AgentEvent.TYPE_REASONING, { text });
    }
    if (part.type === 'tool-use') {
      return new AgentEvent(AgentEvent.TYPE_TOOL_USE, {
        name: part.toolName || part.name || '',
        input: part.toolInput || part.input || {},
      });
    }
    if (part.type === 'tool-result') {
      return new AgentEvent(AgentEvent.TYPE_TOOL_USE, {
        name: part.toolName || part.name || '',
        output: part.toolOutput || part.output || '',
        status: part.isError ? 'error' : 'done',
      });
    }
  }

  if (type === 'session.error') {
    const errMsg = typeof props.error === 'string'
      ? props.error
      : (props.error && props.error.message) || 'session error';
    return new AgentEvent(AgentEvent.TYPE_ERROR, { message: errMsg });
  }

  return null;
}

function isTerminalSSEEvent(raw, sessionId) {
  raw = normalizeSSEEvent(raw);
  if (!raw || !raw.properties) return false;
  const props = raw.properties;
  const eventSessionId = props.sessionID || props.sessionId || (props.session && props.session.id);
  if (sessionId && eventSessionId !== sessionId) return false;
  if (raw.type === 'session.error') return true;
  if (raw.type !== 'session.status') return false;
  return props.status && props.status.type === 'idle';
}

function isUserMessageEvent(props) {
  const role = props.role
    || (props.message && props.message.role)
    || (props.part && props.part.role)
    || (props.author && props.author.role);
  return role === 'user';
}

function extractMessageId(raw, sessionId) {
  raw = normalizeSSEEvent(raw);
  if (!raw || !raw.properties) return '';
  const props = raw.properties;
  if (!eventBelongsToSession(props, sessionId)) return '';
  return props.messageID || props.messageId || (props.message && props.message.id) || '';
}

module.exports = {
  normalizeSSEEvent,
  eventBelongsToSession,
  mapSSEEvent,
  isTerminalSSEEvent,
  isUserMessageEvent,
  extractMessageId,
};
