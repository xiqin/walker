/** Walker 支持的命令定义表，包含描述和使用方式 */
const COMMANDS = {
  new: { desc: '创建新会话', usage: '/new [agent] [name]' },
  attach: { desc: '发现并纳入已有 OpenCode 会话', usage: '/attach' },
  list: { desc: '列出所有会话', usage: '/list' },
  use: { desc: '绑定当前对话到指定会话', usage: '/use <session_id> | /use off' },
  current: { desc: '查看当前绑定的会话', usage: '/current' },
  stop: { desc: '停止当前会话', usage: '/stop' },
  cancel: { desc: '取消当前 turn', usage: '/cancel' },
  status: { desc: '查看当前会话状态', usage: '/status' },
  ps: { desc: '/status 的别名', usage: '/ps' },
  delete: { desc: '删除指定会话', usage: '/delete <session_id>' },
  clear: { desc: '在当前 TUI 新建空上下文并保留旧会话', usage: '/clear' },
  model: { desc: '列出可用模型或切换当前会话模型', usage: '/model | /model <model_id>' },
  agents: { desc: '列出可用的 Agent 类型', usage: '/agents' },
  runtime: { desc: '查看当前运行时环境', usage: '/runtime' },
  permit: { desc: '回复权限确认请求', usage: '/permit <permissionId> <allow|deny>' },
  answer: { desc: '回复交互式问题', usage: '/answer <questionKey> --option <optionValue> <walkerSessionId> | /answer <questionKey> --toggle <optionValue> <walkerSessionId> | /answer <questionKey> --submit <walkerSessionId> | /answer <questionKey> --form <walkerSessionId> | /answer <questionKey> --retry <walkerSessionId>' },
  help: { desc: '显示命令帮助', usage: '/help' },
};

const COMMAND_LIST = Object.entries(COMMANDS).map(([name, cmd]) => ({
  name,
  desc: cmd.desc,
  usage: cmd.usage,
}));

/**
 * 解析用户输入文本，识别是否为命令及其参数
 * @param {string} text - 用户输入的原始文本
 * @returns {Object} 解析结果：{ type: 'text', text } 或 { type: 'command', name, args }
 */
function parseCommand(text) {
  if (!text) {
    return { type: 'text', text: '' };
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return { type: 'text', text: text || '' };
  }

  const parts = trimmed.split(/\s+/);
  const name = parts[0].slice(1).toLowerCase();
  const args = parts.slice(1);

  if (!COMMANDS[name]) {
    return { type: 'text', text };
  }

  return { type: 'command', name, args };
}

/**
 * 格式化命令帮助信息为飞书 Markdown 文本
 * @returns {string} 命令清单的 Markdown 格式文本
 */
function formatHelp() {
  const lines = ['**Walker 命令清单**\n'];
  for (const cmd of COMMAND_LIST) {
    lines.push('- **' + cmd.usage + '** — ' + cmd.desc);
  }
  return lines.join('\n');
}

module.exports = { parseCommand, COMMANDS, COMMAND_LIST, formatHelp };
