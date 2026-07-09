const STATUS_EMOJI = {
  created: '⚪',
  running: '🔵',
  idle: '🟢',
  stopped: '🔴',
  error: '⚠️',
  deleted: '❌',
};

const STATUS_TEMPLATE = {
  created: 'default',
  running: 'blue',
  idle: 'green',
  stopped: 'red',
  error: 'red',
  deleted: 'default',
};

function buildButtonValue(cmd, sessionId) {
  return { action: cmd + ' ' + sessionId };
}

function renderSessionListCard(sessions, currentSessionId) {
  if (!sessions || sessions.length === 0) {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Walker 会话列表' }, template: 'default' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '暂无活跃会话\n发送 **/new** 创建新会话' } },
      ],
    };
  }

  const elements = [];
  for (const s of sessions) {
    if (s.state === 'deleted') continue;
    const emoji = STATUS_EMOJI[s.state] || '⚪';
    const isCurrent = s.id === currentSessionId;
    const marker = isCurrent ? ' ← 当前绑定' : '';
    const title = s.title || s.id.slice(0, 12);
    const agentLabel = s.agent || 'opencode';
    const cwdLabel = s.cwd ? s.cwd : '(未设置)';
    const timeLabel = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '';

    elements.push({
      tag: 'column_set',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          vertical_align: 'top',
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: emoji + ' **' + title + '**' + marker + ' `' + s.id.slice(0, 12) + '`'
                  + '\n' + agentLabel + ' · ' + cwdLabel
                  + '\n状态: ' + s.state + (timeLabel ? ' · ' + timeLabel : ''),
              },
            },
          ],
        },
      ],
    });

    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: isCurrent ? '已绑定' : '绑定' }, type: isCurrent ? 'default' : 'primary', value: buildButtonValue('cmd:/use', s.id) },
        { tag: 'button', text: { tag: 'plain_text', content: '停止' }, type: 'default', value: buildButtonValue('cmd:/stop', s.id) },
        { tag: 'button', text: { tag: 'plain_text', content: '删除' }, type: 'danger', value: buildButtonValue('cmd:/delete', s.id) },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Walker 会话列表 (' + sessions.filter((s) => s.state !== 'deleted').length + ')' }, template: 'blue' },
    elements,
  };
}

function renderUnboundRouteCard(routeKey) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '未绑定会话' }, template: 'yellow' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '当前对话未绑定任何 agent 会话\n\n发送 **/new** 创建新会话\n发送 **/list** 查看已有会话并绑定' } },
    ],
  };
}

function renderErrorCard(message) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '错误' }, template: 'red' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: message } },
    ],
  };
}

module.exports = {
  renderSessionListCard,
  renderUnboundRouteCard,
  renderErrorCard,
  buildButtonValue,
  STATUS_EMOJI,
  STATUS_TEMPLATE,
};
