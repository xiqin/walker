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
class AgentEvent {
  /**
   * 创建 Agent 事件
   * @param {string} type - 事件类型（text/reasoning/tool_use/error/status/done）
   * @param {Object} data - 事件数据
   */
  constructor(type, data) {
    this.type = type;
    this.data = data;
  }
}

/** 事件类型常量：文本输出 */
AgentEvent.TYPE_TEXT = 'text';
/** 事件类型常量：推理过程 */
AgentEvent.TYPE_REASONING = 'reasoning';
/** 事件类型常量：工具调用（含结果，status 字段区分进行中/完成/错误） */
AgentEvent.TYPE_TOOL_USE = 'tool_use';
/** 事件类型常量：错误 */
AgentEvent.TYPE_ERROR = 'error';
/** 事件类型常量：状态变更 */
AgentEvent.TYPE_STATUS = 'status';
/** 事件类型常量：完成 */
AgentEvent.TYPE_DONE = 'done';

module.exports = { AgentDriver, AgentEvent };
