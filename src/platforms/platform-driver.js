'use strict';

const REQUIRED_PLATFORM_EVENT_FIELDS = ['platform', 'type', 'messageId', 'routeKey', 'userId', 'text', 'attachments', 'raw'];

class PlatformDriver {
  constructor(options) {
    this.platform = options && options.platform || '';
  }

  async start() {
    throw new Error('PlatformDriver.start not implemented');
  }

  async stop() {
    throw new Error('PlatformDriver.stop not implemented');
  }

  async sendMessage() {
    throw new Error('PlatformDriver.sendMessage not implemented');
  }

  async updateMessage() {
    throw new Error('PlatformDriver.updateMessage not implemented');
  }

  async sendCard() {
    throw new Error('PlatformDriver.sendCard not implemented');
  }

  async uploadAttachment() {
    throw new Error('PlatformDriver.uploadAttachment not implemented');
  }
}

function validatePlatformEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object') {
    return { ok: false, code: 'BAD_REQUEST', errors: ['event must be an object'] };
  }
  for (const field of REQUIRED_PLATFORM_EVENT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(event, field)) errors.push('missing ' + field);
  }
  if (event.platform !== undefined && typeof event.platform !== 'string') errors.push('platform must be a string');
  if (event.type !== undefined && event.type !== 'message') errors.push('type must be message');
  for (const field of ['messageId', 'routeKey', 'userId']) {
    if (event[field] !== undefined && typeof event[field] !== 'string') errors.push(field + ' must be a string');
    if (event[field] === '') errors.push(field + ' is required');
  }
  if (event.text !== undefined && typeof event.text !== 'string') errors.push('text must be a string');
  if (event.attachments !== undefined && !Array.isArray(event.attachments)) errors.push('attachments must be an array');
  if (event.raw !== undefined && (!event.raw || typeof event.raw !== 'object')) errors.push('raw must be an object');
  return errors.length === 0 ? { ok: true } : { ok: false, code: 'BAD_REQUEST', errors };
}

function assertPlatformEvent(event) {
  const result = validatePlatformEvent(event);
  if (!result.ok) {
    const error = new Error('invalid platform event: ' + result.errors.join(', '));
    error.code = result.code;
    error.details = result.errors;
    throw error;
  }
  return event;
}

module.exports = { PlatformDriver, REQUIRED_PLATFORM_EVENT_FIELDS, validatePlatformEvent, assertPlatformEvent };
