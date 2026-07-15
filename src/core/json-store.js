const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');
const { IStore } = require('./store-interface');

const logger = createLogger('json-store');

function cloneDefaultValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/**
 * 基于 JSON 文件的持久化存储，支持原子读写和变异更新
 * update 为同步操作，在 Node.js 单线程事件循环中天然串行，不会出现 lost update
 * updateAsync 提供异步互斥版本，用于 await 后的异步调用场景
 */
class JsonStore extends IStore {
  constructor(filePath, defaultValue) {
    super();
    this.filePath = filePath;
    this.defaultValue = defaultValue;
    this._queue = Promise.resolve();
    this._corrupted = false;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  read() {
    if (!fs.existsSync(this.filePath)) {
      return cloneDefaultValue(this.defaultValue);
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      this._corrupted = false;
      return data;
    } catch (e) {
      logger.error('failed to read/persist file, using default', { filePath: this.filePath, err: e });
      if (!this._corrupted) {
        this._corrupted = true;
        const ts = Date.now();
        const backupPath = this.filePath + '.corrupt.' + ts;
        try {
          fs.renameSync(this.filePath, backupPath);
          logger.warn('corrupted file backed up', { original: this.filePath, backup: backupPath });
        } catch (backupErr) {
          logger.error('failed to backup corrupted file', { filePath: this.filePath, err: backupErr });
        }
      }
      return cloneDefaultValue(this.defaultValue);
    }
  }

  /**
   * 将数据原子写入 JSON 文件（先写临时文件再重命名）
   * @param {*} value - 要写入的数据
   */
  write(value) {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = this.filePath + '.tmp';
    if (fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  /**
   * 同步更新：读取当前数据，通过变异函数修改后写回
   * 在 Node.js 单线程事件循环中，同步操作天然串行，不会出现 lost update
   * @param {Function} mutator - 接收当前数据并就地修改的函数
   */
  update(mutator) {
    if (this._corrupted) {
      logger.warn('updating from corrupted fallback — data loss may occur', { filePath: this.filePath });
    }
    const current = this.read();
    mutator(current);
    this.write(current);
  }

  updateAsync(mutator) {
    const task = () => {
      if (this._corrupted) {
        logger.warn('updating from corrupted fallback — data loss may occur', { filePath: this.filePath });
      }
      const current = this.read();
      mutator(current);
      this.write(current);
    };
    this._queue = this._queue.then(task, task);
    return this._queue;
  }
}

module.exports = { JsonStore };
