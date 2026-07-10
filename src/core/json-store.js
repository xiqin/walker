const fs = require('fs');
const path = require('path');

function cloneDefaultValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/**
 * 基于 JSON 文件的持久化存储，支持原子读写和变异更新
 * update 为同步操作，在 Node.js 单线程事件循环中天然串行，不会出现 lost update
 * updateAsync 提供异步互斥版本，用于 await 后的异步调用场景
 */
class JsonStore {
  /**
   * 初始化 JSON 存储实例
   * @param {string} filePath - JSON 文件的绝对路径
   * @param {*} defaultValue - 文件不存在时的默认值
   */
  constructor(filePath, defaultValue) {
    this.filePath = filePath;
    this.defaultValue = defaultValue;
    this._queue = Promise.resolve();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 读取 JSON 文件内容，文件不存在或解析失败时返回默认值
   * @returns {*} 文件中的数据或默认值
   */
  read() {
    if (!fs.existsSync(this.filePath)) {
      return cloneDefaultValue(this.defaultValue);
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
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
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  /**
   * 同步更新：读取当前数据，通过变异函数修改后写回
   * 在 Node.js 单线程事件循环中，同步操作天然串行，不会出现 lost update
   * @param {Function} mutator - 接收当前数据并就地修改的函数
   */
  update(mutator) {
    const current = this.read();
    mutator(current);
    this.write(current);
  }

  /**
   * 异步互斥更新：读取当前数据，通过变异函数修改后写回
   * 并发调用排队执行，避免异步 await 后的 read-mutate-write lost update
   * @param {Function} mutator - 接收当前数据并就地修改的函数
   * @returns {Promise<void>}
   */
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

module.exports = { JsonStore };
