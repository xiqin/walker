'use strict';

/**
 * 命令模拟器模块
 * 输入文本 → parseCommand 结果 → 模拟 routeKey → dispatcher 动作摘要
 * 默认 dry-run=true，描述将执行的操作但不实际执行
 * REQ-020
 */

const { parseCommand, COMMANDS } = require('../platform/feishu/commands');

/**
 * 根据命令名称和参数，生成模拟的 dispatcher 动作摘要
 * @param {Object} parsed - parseCommand 的解析结果
 * @param {string} [routeKey] - 模拟的路由键
 * @returns {Object} 动作摘要对象
 */
function describeAction(parsed, routeKey) {
  if (parsed.type !== 'command') {
    return {
      action: 'send_text',
      description: '将文本消息发送到当前绑定的会话',
      routeKey: routeKey || '',
      details: { text: parsed.text },
    };
  }

  const commandDef = COMMANDS[parsed.name];
  const actions = {
    new: {
      action: 'create_session',
      description: '创建新的 agent 会话并绑定到当前路由',
      details: { agent: parsed.args[0] || 'opencode', name: parsed.args[1] || '' },
    },
    attach: {
      action: 'attach_session',
      description: '发现并纳入已有的 OpenCode 会话',
      details: {},
    },
    list: {
      action: 'list_sessions',
      description: '列出所有会话',
      details: {},
    },
    use: {
      action: 'bind_route',
      description: parsed.args[0] === 'off' ? '解除当前路由绑定' : '绑定当前对话到指定会话',
      details: { sessionId: parsed.args[0] || '' },
    },
    current: {
      action: 'show_current',
      description: '查看当前绑定的会话信息',
      details: {},
    },
    stop: {
      action: 'stop_session',
      description: '停止当前绑定的会话',
      details: { routeKey: routeKey || '' },
    },
    delete: {
      action: 'delete_session',
      description: '删除指定会话',
      details: { sessionId: parsed.args[0] || '' },
    },
    model: {
      action: 'switch_model',
      description: parsed.args[0] ? '切换当前会话模型' : '列出可用模型',
      details: { modelId: parsed.args[0] || '' },
    },
    cancel: {
      action: 'cancel_turn',
      description: '取消当前正在进行的对话',
      details: {},
    },
    status: {
      action: 'show_status',
      description: '查看当前会话状态',
      details: {},
    },
    ps: {
      action: 'show_status',
      description: '/status 的别名',
      details: {},
    },
    agents: {
      action: 'list_agents',
      description: '列出可用的 Agent 类型',
      details: {},
    },
    runtime: {
      action: 'show_runtime',
      description: '查看当前运行时环境',
      details: {},
    },
    help: {
      action: 'show_help',
      description: '显示命令帮助信息',
      details: {},
    },
  };

  const actionInfo = actions[parsed.name] || {
    action: 'unknown',
    description: '未知命令',
    details: { name: parsed.name, args: parsed.args },
  };

  return {
    action: actionInfo.action,
    description: actionInfo.description,
    routeKey: routeKey || '',
    command: parsed.name,
    args: parsed.args,
    details: actionInfo.details,
  };
}

/**
 * 模拟命令执行：解析文本并生成动作摘要，默认 dry-run=true
 * @param {string} text - 用户输入的原始文本
 * @param {Object} [options] - 模拟选项
 * @param {string} [options.routeKey] - 模拟的路由键
 * @param {boolean} [options.dryRun] - 是否为试运行模式，默认 true
 * @returns {Object} 模拟结果对象
 */
function simulateCommand(text, options) {
  const opts = options || {};
  const dryRun = opts.dryRun !== false;
  const parsed = parseCommand(text);

  const result = {
    input: text,
    parsed,
    action: describeAction(parsed, opts.routeKey),
    dryRun,
  };

  if (parsed.type === 'command') {
    result.commandDef = COMMANDS[parsed.name] || null;
  }

  return result;
}

module.exports = { simulateCommand, describeAction };
