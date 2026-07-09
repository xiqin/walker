'use strict';

class AgentDriver {
  constructor(name) {
    this.name = name;
  }

  async ensureReady() {
    throw new Error('ensureReady not implemented by ' + this.name);
  }

  async createSession(options) {
    throw new Error('createSession not implemented by ' + this.name);
  }

  async resumeSession(sessionRef) {
    throw new Error('resumeSession not implemented by ' + this.name);
  }

  async prompt(sessionRef, text) {
    throw new Error('prompt not implemented by ' + this.name);
  }

  async stop(sessionRef) {
    throw new Error('stop not implemented by ' + this.name);
  }

  async delete(sessionRef) {
    throw new Error('delete not implemented by ' + this.name);
  }
}

class AgentEvent {
  constructor(type, data) {
    this.type = type;
    this.data = data;
  }
}

AgentEvent.TYPE_TEXT = 'text';
AgentEvent.TYPE_REASONING = 'reasoning';
AgentEvent.TYPE_TOOL_USE = 'tool_use';
AgentEvent.TYPE_TOOL_RESULT = 'tool_result';
AgentEvent.TYPE_ERROR = 'error';
AgentEvent.TYPE_STATUS = 'status';
AgentEvent.TYPE_DONE = 'done';

module.exports = { AgentDriver, AgentEvent };
