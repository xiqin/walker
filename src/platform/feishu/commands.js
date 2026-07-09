const COMMANDS = {
  new: { desc: '创建新会话', usage: '/new [agent] [name]' },
  list: { desc: '列出所有会话', usage: '/list' },
  use: { desc: '绑定当前对话到指定会话', usage: '/use <session_id> | /use off' },
  current: { desc: '查看当前绑定的会话', usage: '/current' },
  stop: { desc: '停止当前会话', usage: '/stop' },
  delete: { desc: '删除指定会话', usage: '/delete <session_id>' },
  agents: { desc: '列出可用的 Agent 类型', usage: '/agents' },
  runtime: { desc: '查看当前运行时环境', usage: '/runtime' },
  help: { desc: '显示命令帮助', usage: '/help' },
};

function parseCommand(text) {
  if (!text || !text.startsWith('/')) {
    return { type: 'text', text: text || '' };
  }

  const parts = text.trim().split(/\s+/);
  const name = parts[0].slice(1).toLowerCase();
  const args = parts.slice(1);

  if (!COMMANDS[name]) {
    return { type: 'text', text };
  }

  return { type: 'command', name, args };
}

function formatHelp() {
  const lines = ['**Walker 命令清单**\n'];
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    lines.push('- **' + cmd.usage + '** — ' + cmd.desc);
  }
  return lines.join('\n');
}

module.exports = { parseCommand, COMMANDS, formatHelp };
