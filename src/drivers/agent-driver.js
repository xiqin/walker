'use strict';

/**
 * Agent 驱动基类，定义所有 Agent 驱动必须实现的接口
 */
class AgentDriver {
  /**
   * 初始化驱动
   * @param {string} name - 驱动名称标识
   */
  constructor(name) {
    this.name = name;
  }

  /**
   * 确保 Agent 服务就绪可用
   * @returns {Promise<boolean>} 服务就绪返回 true
   */
  async ensureReady() {
    throw new Error('ensureReady not implemented by ' + this.name);
  }

  /**
   * 创建新的 Agent 会话
   * @param {Object} options - 创建会话的选项
   * @returns {Promise<Object>} 会话引用对象
   */
  async createSession(options) {
    throw new Error('createSession not implemented by ' + this.name);
  }

  /**
   * 恢复已有会话
   * @param {Object} sessionRef - 会话引用对象
   * @returns {Promise<Object>} 恢复后的会话引用
   */
  async resumeSession(sessionRef) {
    throw new Error('resumeSession not implemented by ' + this.name);
  }

  /**
   * 列出可恢复的已有会话
   * @param {Object} options - 查询选项
   * @returns {Promise<Object[]>} 会话摘要列表
   */
  async listSessions(options) {
    throw new Error('listSessions not implemented by ' + this.name);
  }

  /**
   * 列出可用模型目录
   * @returns {Promise<Object[]>} 统一模型视图列表
   */
  async listModels() {
    throw new Error(this.name + ' driver does not support model catalog');
  }

  /**
   * 向会话发送提示文本并获取响应
   * @param {Object} sessionRef - 会话引用对象
   * @param {string} text - 提示文本内容
   * @returns {Promise<AgentEvent[]>} Agent 事件列表
   */
  async prompt(sessionRef, text) {
    throw new Error('prompt not implemented by ' + this.name);
  }

  /**
   * 停止指定会话的运行
   * @param {Object} sessionRef - 会话引用对象
   * @returns {Promise<void>}
   */
  async stop(sessionRef) {
    throw new Error('stop not implemented by ' + this.name);
  }

  /**
   * 删除指定会话
   * @param {Object} sessionRef - 会话引用对象
   * @returns {Promise<void>}
   */
  async delete(sessionRef) {
    throw new Error('delete not implemented by ' + this.name);
  }
}

/**
 * Agent 事件，封装 Agent 返回的各种类型事件数据
 */
const EVENT_TYPE_TEXT = 'text';
const EVENT_TYPE_REASONING = 'reasoning';
const EVENT_TYPE_TOOL_USE = 'tool_use';
const EVENT_TYPE_ERROR = 'error';
const EVENT_TYPE_STATUS = 'status';
const EVENT_TYPE_DONE = 'done';

class AgentEvent {
  static DATA_SCHEMAS = {
    [EVENT_TYPE_TEXT]: { text: 'string', delta: 'boolean?' },
    [EVENT_TYPE_REASONING]: { text: 'string' },
    [EVENT_TYPE_TOOL_USE]: { name: 'string', input: 'object?', output: 'string?', status: 'string?' },
    [EVENT_TYPE_ERROR]: { message: 'string' },
    [EVENT_TYPE_STATUS]: { status: 'string' },
    [EVENT_TYPE_DONE]: { reason: 'string?' },
  };

  constructor(type, data) {
    this.type = type;
    this.data = data;
  }
}

AgentEvent.TYPE_TEXT = EVENT_TYPE_TEXT;
AgentEvent.TYPE_REASONING = EVENT_TYPE_REASONING;
AgentEvent.TYPE_TOOL_USE = EVENT_TYPE_TOOL_USE;
AgentEvent.TYPE_ERROR = EVENT_TYPE_ERROR;
AgentEvent.TYPE_STATUS = EVENT_TYPE_STATUS;
AgentEvent.TYPE_DONE = EVENT_TYPE_DONE;

module.exports = { AgentDriver, AgentEvent };
