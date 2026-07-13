/** 会话状态对应的表情符号映射 */
const STATUS_EMOJI = {
  created: '⚪',
  running: '🔵',
  idle: '🟢',
  stopped: '🔴',
  error: '⚠️',
  deleted: '❌',
};

/** 会话状态对应的卡片标题模板颜色 */
const STATUS_TEMPLATE = {
  created: 'default',
  running: 'blue',
  idle: 'green',
  stopped: 'red',
  error: 'red',
  deleted: 'default',
};

/** 可纳入会话卡片最多展示的候选数，避免整卡超限 */
const MAX_ATTACHABLE_CARD_ITEMS = 10;

/**
 * 构建飞书卡片按钮的 value 字段，封装命令和会话 ID，可选携带 routeKey 用于回调精准路由
 * @param {string} cmd - 命令字符串，如 'cmd:/use'
 * @param {string} sessionId - 目标会话 ID
 * @param {string} [routeKey] - 路由键，嵌入按钮值以便卡片回调时直接使用
 * @returns {Object} 按钮的 value 对象
 */
function buildButtonValue(cmd, sessionId, routeKey) {
  const value = { action: cmd + ' ' + sessionId };
  if (routeKey) value.routeKey = routeKey;
  return value;
}

/**
 * 构建不带会话 ID 的命令按钮 value 字段，可选携带 routeKey
 * @param {string} cmd - 命令字符串，如 'cmd:/attach'
 * @param {string} [routeKey] - 路由键，嵌入按钮值以便卡片回调时直接使用
 * @returns {Object} 按钮的 value 对象
 */
function buildCommandValue(cmd, routeKey) {
  const value = { action: cmd };
  if (routeKey) value.routeKey = routeKey;
  return value;
}

/**
 * 渲染会话列表的飞书卡片 JSON 结构
 * @param {Object[]} sessions - 会话对象列表
 * @param {string|null} currentSessionId - 当前绑定的会话 ID
 * @param {string} [routeKey] - 路由键，嵌入按钮值以便卡片回调精准路由
 * @returns {Object} 飞书卡片 JSON 结构
 */
function renderSessionListCard(sessions, currentSessionId, routeKey) {
  if (!sessions || sessions.length === 0) {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Walker 会话列表' }, template: 'default' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '暂无活跃会话\n发送 **/new** 创建新会话，或发送 **/attach** 纳入已有 OpenCode 会话' } },
        { tag: 'action', actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '纳入已有 OpenCode' }, type: 'primary', value: buildCommandValue('cmd:/attach', routeKey) },
          { tag: 'button', text: { tag: 'plain_text', content: '新建会话' }, type: 'default', value: buildCommandValue('cmd:/new', routeKey) },
        ] },
      ],
    };
  }

  const elements = [];
  for (const s of sessions) {
    if (s.status === 'deleted') continue;
    const emoji = STATUS_EMOJI[s.status] || '⚪';
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
                  + '\n状态: ' + s.status + (timeLabel ? ' · ' + timeLabel : ''),
              },
            },
          ],
        },
      ],
    });

    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: isCurrent ? '已聚焦' : '设为焦点' }, type: isCurrent ? 'default' : 'primary', value: buildButtonValue('cmd:/use', s.id, routeKey) },
        { tag: 'button', text: { tag: 'plain_text', content: '停止' }, type: 'default', value: buildButtonValue('cmd:/stop', s.id, routeKey) },
        { tag: 'button', text: { tag: 'plain_text', content: '删除' }, type: 'danger', value: buildButtonValue('cmd:/delete', s.id, routeKey) },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Walker 会话列表 (' + sessions.filter((s) => s.status !== 'deleted').length + ')' }, template: 'blue' },
    elements,
  };
}

/**
 * 渲染未绑定会话的提示飞书卡片
 * @param {string} routeKey - 当前路由键
 * @returns {Object} 飞书卡片 JSON 结构
 */
function renderUnboundRouteCard(routeKey) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '未绑定会话' }, template: 'yellow' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '当前对话未绑定任何 agent 会话\n\n可以直接纳入已启动的 OpenCode 会话，或新建一个会话。' } },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '纳入已有 OpenCode' }, type: 'primary', value: buildCommandValue('cmd:/attach', routeKey) },
        { tag: 'button', text: { tag: 'plain_text', content: '新建会话' }, type: 'default', value: buildCommandValue('cmd:/new', routeKey) },
        { tag: 'button', text: { tag: 'plain_text', content: '查看 Walker 会话' }, type: 'default', value: buildCommandValue('cmd:/list', routeKey) },
      ] },
    ],
  };
}

/**
 * 渲染可纳入的 OpenCode 会话列表卡片
 * @param {Object[]} sessions - OpenCode 会话摘要列表（已按 updatedAt 倒序排列）
 * @param {Object} [options] - 渲染选项
 * @param {string[]} [options.managedIds] - 已被 Walker 管理的 OpenCode session ID
 * @param {string} [options.routeKey] - 路由键
 * @returns {Object} 飞书卡片 JSON 结构
 */
function renderAttachableSessionCard(sessions, options) {
  const managedIds = new Set((options && options.managedIds) || []);
  const routeKey = options && options.routeKey;
  const attachable = (sessions || []).filter((session) => session && session.id && !managedIds.has(session.id));
  const shown = attachable.slice(0, MAX_ATTACHABLE_CARD_ITEMS);
  const hiddenCount = Math.max(0, attachable.length - shown.length);
  if (attachable.length === 0) {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '可纳入的 OpenCode 会话' }, template: 'default' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '没有发现可纳入的 OpenCode 会话。' } },
        { tag: 'action', actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '新建会话' }, type: 'primary', value: buildCommandValue('cmd:/new', routeKey) },
        ] },
      ],
    };
  }

  const elements = [];
  if (options && options.crossProject) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '以下会话可能来自多个 OpenCode 项目，请核对工作目录后再纳入。' },
    });
  }
  if (hiddenCount > 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '还有 ' + hiddenCount + ' 个候选未展示，请使用 `/attach <id>` 精确纳入。' },
    });
  }
  for (const session of shown) {
    const title = session.title || ('opencode ' + session.id.slice(0, 12));
    const cwdLabel = session.cwd || '(未设置)';
    const status = session.status || 'unknown';
    const timeLabel = session.updatedAt ? formatRelativeTime(session.updatedAt) : '';
    const metaParts = [cwdLabel, '状态: ' + status];
    if (timeLabel) metaParts.push(timeLabel);
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '**' + title + '** `' + session.id.slice(0, 12) + '`\n' + metaParts.join(' · '),
      },
    });
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '纳入并绑定' }, type: 'primary', value: buildButtonValue('cmd:/attach', session.id, routeKey) },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '可纳入的 OpenCode 会话 (' + attachable.length + ')' }, template: 'blue' },
    elements,
  };
}

/**
 * 将毫秒级时间戳格式化为相对时间描述
 * @param {number} ts - 毫秒级时间戳
 * @returns {string} 相对时间描述，如 "刚刚"、"5分钟前"、"2小时前"、"3天前"
 */
function formatRelativeTime(ts) {
  if (!ts || typeof ts !== 'number') return '';
  const now = Date.now();
  const diff = now - ts;
  if (diff < 0) return '刚刚';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + '分钟前';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + '小时前';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + '天前';
  return new Date(ts).toLocaleDateString();
}

/**
 * 渲染错误提示飞书卡片
 * @param {string} message - 错误描述信息
 * @returns {Object} 飞书卡片 JSON 结构
 */
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
  renderAttachableSessionCard,
  renderErrorCard,
  buildButtonValue,
  buildCommandValue,
  STATUS_EMOJI,
  STATUS_TEMPLATE,
};
