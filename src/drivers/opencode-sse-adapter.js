'use strict';

const { AgentEvent } = require('./agent-driver');
const { createLogger } = require('../core/logger');
const logger = createLogger('opencode-sse-adapter');

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
    if (part.type === 'step-start' || part.type === 'step-finish') {
      return new AgentEvent(AgentEvent.TYPE_STEP, { partType: part.type, stepId: part.stepId || part.id || '' });
    }
    if (part.type === 'file') {
      return new AgentEvent(AgentEvent.TYPE_FILE_EDITED, {
        path: part.path || part.file || part.name || '',
        action: part.action || 'edit',
        linesAdded: part.linesAdded,
        linesRemoved: part.linesRemoved,
      });
    }
    if (part.type === 'patch') {
      return new AgentEvent(AgentEvent.TYPE_FILE_EDITED, {
        path: part.path || part.file || part.name || '',
        action: 'patch',
        linesAdded: part.linesAdded,
        linesRemoved: part.linesRemoved,
      });
    }
    if (part.type === 'snapshot' || part.type === 'agent' || part.type === 'retry' || part.type === 'compaction' || part.type === 'subtask') {
      logger.debug('opencode-sse-adapter: 静默记录 part.type', { partType: part.type });
      return null;
    }
  }

  if (type === 'session.error') {
    const errMsg = typeof props.error === 'string'
      ? props.error
      : (props.error && props.error.message) || 'session error';
    return new AgentEvent(AgentEvent.TYPE_ERROR, { message: errMsg });
  }

  if (type === 'permission.updated') {
    return new AgentEvent(AgentEvent.TYPE_PERMISSION, {
      id: props.id || props.permissionId || '',
      type: props.type || '',
      title: props.title || '',
      metadata: props.metadata || null,
      sessionID: props.sessionID || props.sessionId || '',
      messageID: props.messageID || props.messageId || '',
      callID: props.callID || props.callId || undefined,
    });
  }

  if (type === 'permission.replied') {
    return new AgentEvent(AgentEvent.TYPE_PERMISSION_REPLIED, {
      permissionId: props.permissionId || props.id || '',
      response: props.response || '',
    });
  }

  if (type === 'todo.updated') {
    return new AgentEvent(AgentEvent.TYPE_TODO, { todos: props.todos || [] });
  }

  if (type === 'session.compacted') {
    return new AgentEvent(AgentEvent.TYPE_COMPACTED, {
      sessionID: props.sessionID || props.sessionId || '',
    });
  }

  if (type === 'file.edited') {
    return new AgentEvent(AgentEvent.TYPE_FILE_EDITED, {
      path: props.path || '',
      action: props.action || 'edit',
      linesAdded: props.linesAdded,
      linesRemoved: props.linesRemoved,
    });
  }

  if (type === 'session.diff') {
    return new AgentEvent(AgentEvent.TYPE_SESSION_DIFF, {
      diff: props.diff || '',
      filesCount: props.filesCount || 0,
      linesAdded: props.linesAdded || 0,
      linesRemoved: props.linesRemoved || 0,
    });
  }

  if (type === 'message.removed' || type === 'message.part.removed') {
    return new AgentEvent(AgentEvent.TYPE_MESSAGE_REMOVED, {
      messageId: props.messageID || props.messageId || '',
      partId: props.partID || props.partId || undefined,
    });
  }

  if (type === 'command.executed') {
    return new AgentEvent(AgentEvent.TYPE_COMMAND_EXECUTED, {
      command: props.command || '',
      exitCode: props.exitCode !== undefined ? props.exitCode : -1,
    });
  }

  if (type === 'session.created' || type === 'session.updated' || type === 'session.deleted') {
    const action = type.replace('session.', '');
    return new AgentEvent(AgentEvent.TYPE_SESSION_LIFECYCLE, {
      action: action,
      session: props.session || props,
    });
  }

  if (type === 'server.connected') {
    return new AgentEvent(AgentEvent.TYPE_SERVER_CONNECTED, {});
  }

  const silentDiscard = [
    'installation.updated', 'installation.update-available',
    'lsp.client.diagnostics', 'lsp.updated',
    'vcs.branch.updated', 'file.watcher.updated',
    'tui.prompt.append', 'tui.command.execute', 'tui.toast.show',
    'pty.created', 'pty.updated', 'pty.exited', 'pty.deleted',
    'server.instance.disposed',
  ];
  if (silentDiscard.includes(type)) {
    logger.debug('opencode-sse-adapter: 丢弃事件', { type });
    return null;
  }

  logger.debug('opencode-sse-adapter: 未知事件类型', { type });
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
