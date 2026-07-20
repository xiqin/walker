'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentEvent } = require('../src/drivers/agent-driver');

test('PERMISSION_REPLIED schema: response is string', () => {
  const schema = AgentEvent.DATA_SCHEMAS[AgentEvent.TYPE_PERMISSION_REPLIED];
  assert.equal(schema.response, 'string');
});

test('PERMISSION schema: metadata is object?', () => {
  const schema = AgentEvent.DATA_SCHEMAS[AgentEvent.TYPE_PERMISSION];
  assert.equal(schema.metadata, 'object?');
});

test('existing permission event constructs AgentEvent without question metadata', () => {
  const evt = new AgentEvent(AgentEvent.TYPE_PERMISSION, {
    id: 'perm-1',
    type: 'file_edit',
    title: 'Allow edit?',
    sessionID: 'sess-1',
    messageID: 'msg-1',
  });
  assert.equal(evt.type, 'permission');
  assert.equal(evt.data.id, 'perm-1');
  assert.equal(evt.data.metadata, undefined);
});

test('permission event with question metadata constructs AgentEvent', () => {
  const evt = new AgentEvent(AgentEvent.TYPE_PERMISSION, {
    id: 'perm-2',
    type: 'question',
    title: 'Choose option',
    metadata: { inputMode: 'select', options: ['A', 'B'], required: true },
    sessionID: 'sess-1',
    messageID: 'msg-2',
  });
  assert.equal(evt.data.metadata.inputMode, 'select');
  assert.deepEqual(evt.data.metadata.options, ['A', 'B']);
  assert.equal(evt.data.metadata.required, true);
});

test('permission_replied event with string response constructs AgentEvent', () => {
  const evt = new AgentEvent(AgentEvent.TYPE_PERMISSION_REPLIED, {
    permissionId: 'perm-1',
    response: 'allow',
  });
  assert.equal(evt.data.response, 'allow');
});

test('permission event with unknown inputMode is not rejected by schema', () => {
  const evt = new AgentEvent(AgentEvent.TYPE_PERMISSION, {
    id: 'perm-3',
    type: 'question',
    title: 'Unknown mode',
    metadata: { inputMode: 'future_mode', options: [], required: false },
    sessionID: 'sess-1',
    messageID: 'msg-3',
  });
  assert.equal(evt.data.metadata.inputMode, 'future_mode');
});

test('question_asked accepts complete native request', () => {
  const schema = AgentEvent.DATA_SCHEMAS[AgentEvent.TYPE_QUESTION_ASKED];
  assert.equal(AgentEvent.TYPE_QUESTION_ASKED, 'question_asked');
  assert.deepEqual(schema, {
    requestID: 'string',
    sessionID: 'string',
    questions: {
      type: 'object[]',
      minItems: 1,
      items: {
        question: 'string',
        header: 'string',
        options: {
          type: 'object[]',
          items: {
            label: 'string',
            description: 'string',
          },
        },
        multiple: 'boolean?',
        custom: 'boolean?',
      },
    },
    tool: 'object?',
  });

  const questions = [{
    question: 'Choose a deployment region',
    header: 'Region',
    options: [
      { label: 'Asia', description: 'Low latency' },
      { label: 'Europe', description: 'Data residency' },
    ],
    multiple: false,
    custom: true,
  }, {
    question: 'Choose a deployment stage',
    header: 'Stage',
    options: [
      { label: 'Staging', description: 'Pre-production validation' },
      { label: 'Production', description: 'Live traffic' },
    ],
    multiple: true,
    custom: false,
  }];
  const evt = new AgentEvent(AgentEvent.TYPE_QUESTION_ASKED, {
    requestID: 'req-1',
    sessionID: 'sess-1',
    questions,
    tool: { messageID: 'msg-1', callID: 'call-1' },
  });
  assert.equal(evt.type, 'question_asked');
  assert.deepEqual(evt.data.questions, questions);
});

test('question_replied declares final answers schema', () => {
  const schema = AgentEvent.DATA_SCHEMAS[AgentEvent.TYPE_QUESTION_REPLIED];
  assert.equal(AgentEvent.TYPE_QUESTION_REPLIED, 'question_replied');
  assert.deepEqual(schema, {
    requestID: 'string',
    sessionID: 'string',
    answers: 'string[][]',
  });

  const evt = new AgentEvent(AgentEvent.TYPE_QUESTION_REPLIED, {
    requestID: 'req-1',
    sessionID: 'sess-1',
    answers: [['Asia'], ['Staging']],
  });
  assert.deepEqual(evt.data.answers, [['Asia'], ['Staging']]);
});

test('question_rejected declares request identity schema', () => {
  const schema = AgentEvent.DATA_SCHEMAS[AgentEvent.TYPE_QUESTION_REJECTED];
  assert.equal(AgentEvent.TYPE_QUESTION_REJECTED, 'question_rejected');
  assert.deepEqual(schema, {
    requestID: 'string',
    sessionID: 'string',
  });

  const evt = new AgentEvent(AgentEvent.TYPE_QUESTION_REJECTED, {
    requestID: 'req-1',
    sessionID: 'sess-1',
  });
  assert.equal(evt.data.requestID, 'req-1');
});
