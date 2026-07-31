'use strict';

function createEventBus(options) {
  const opts = options || {};
  const listeners = new Set();
  const errors = [];
  const onListenerError = typeof opts.onListenerError === 'function' ? opts.onListenerError : null;

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    return function unsubscribe() {
      return listeners.delete(listener);
    };
  }

  function publish(event) {
    const snapshot = Array.from(listeners);
    for (const listener of snapshot) {
      setImmediate(() => {
        try {
          const result = listener(event);
          if (result && typeof result.then === 'function') {
            result.catch((err) => recordListenerError(err, event, listener));
          }
        } catch (err) {
          recordListenerError(err, event, listener);
        }
      });
    }
    return snapshot.length;
  }

  function unsubscribe(listener) {
    return listeners.delete(listener);
  }

  function recordListenerError(err, event, listener) {
    const entry = {
      err,
      event,
      listener,
      createdAt: Date.now(),
    };
    errors.push(entry);
    if (errors.length > 100) errors.splice(0, errors.length - 100);
    if (onListenerError) {
      try { onListenerError(entry); } catch (_) {}
    }
  }

  return {
    publish,
    subscribe,
    unsubscribe,
    getListenerCount: () => listeners.size,
    getErrors: () => errors.slice(),
  };
}

module.exports = { createEventBus };
