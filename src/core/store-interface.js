'use strict';

class IStore {
  read() {
    throw new Error('IStore.read() not implemented');
  }

  write(value) {
    throw new Error('IStore.write() not implemented');
  }

  update(mutator) {
    throw new Error('IStore.update() not implemented');
  }

  updateAsync(mutator) {
    throw new Error('IStore.updateAsync() not implemented');
  }
}

class InMemoryStore extends IStore {
  constructor(defaultValue) {
    super();
    this._data = defaultValue !== undefined ? JSON.parse(JSON.stringify(defaultValue)) : {};
    this._queue = Promise.resolve();
  }

  read() {
    return JSON.parse(JSON.stringify(this._data));
  }

  write(value) {
    this._data = JSON.parse(JSON.stringify(value));
  }

  update(mutator) {
    const current = this.read();
    mutator(current);
    this.write(current);
  }

  updateAsync(mutator) {
    const task = () => {
      const current = this.read();
      mutator(current);
      this.write(current);
    };
    this._queue = this._queue.then(task, task);
    return this._queue;
  }
}

module.exports = { IStore, InMemoryStore };
