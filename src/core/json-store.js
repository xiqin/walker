const fs = require('fs');
const path = require('path');

/**
 * 基于 JSON 文件的持久化存储，支持原子读写和变异更新
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
      return this.defaultValue;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      return this.defaultValue;
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
   * 读取当前数据，通过变异函数修改后写回
   * @param {Function} mutator - 接收当前数据并就地修改的函数
   */
  update(mutator) {
    const current = this.read();
    mutator(current);
    this.write(current);
  }
}

module.exports = { JsonStore };
