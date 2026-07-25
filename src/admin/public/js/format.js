const STATUS = {
  healthy: { label: '正常', icon: '✓', tone: 'success' },
  active: { label: '活跃', icon: '●', tone: 'success' },
  connected: { label: '已连接', icon: '✓', tone: 'success' },
  created: { label: '已创建', icon: '○', tone: 'neutral' },
  running: { label: '运行中', icon: '●', tone: 'success' },
  idle: { label: '空闲', icon: '◷', tone: 'warning' },
  stopped: { label: '已停止', icon: '■', tone: 'neutral' },
  deleted: { label: '已删除', icon: '×', tone: 'danger' },
  warning: { label: '警告', icon: '△', tone: 'warning' },
  waiting: { label: '等待', icon: '◷', tone: 'warning' },
  failed: { label: '异常', icon: '!', tone: 'danger' },
  error: { label: '异常', icon: '!', tone: 'danger' },
  unknown: { label: '未知', icon: '?', tone: 'neutral' },
};

/** 格式化时间戳，缺失或非法值返回稳定占位。 */
export function formatDateTime(value, locale = 'zh-CN') {
  if (value == null || value === '') return '未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知';
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date);
}

/** 将后端状态映射为同时包含文字、图标和色调的展示模型。 */
export function formatStatus(status) {
  return { ...(STATUS[String(status || 'unknown').toLowerCase()] || STATUS.unknown) };
}

/** 在保留首尾辨识度的前提下缩短 ID。 */
export function shortId(value, maxLength = 14) {
  const text = value == null ? '' : String(value);
  if (!text) return '未知';
  if (text.length <= maxLength) return text;
  const side = Math.max(2, Math.floor((maxLength - 1) / 2));
  return text.slice(0, side) + '…' + text.slice(-side);
}

/** 压缩长路径并保留盘符、末端目录和文件名。 */
export function compactPath(value, maxLength = 48) {
  const text = value == null ? '' : String(value);
  if (!text) return '未知';
  if (text.length <= maxLength) return text;
  const separator = text.includes('\\') ? '\\' : '/';
  const parts = text.split(separator).filter(Boolean);
  const prefix = /^[A-Za-z]:/.test(text) ? parts.shift() + separator : separator;
  if (parts.length >= 2) {
    const usefulTail = separator + parts.slice(-2).join(separator);
    if ((prefix + '…' + usefulTail).length <= maxLength + 2) return prefix + '…' + usefulTail;
  }
  let tail = '';
  while (parts.length > 0) {
    const candidate = separator + parts.pop() + tail;
    if ((prefix + '…' + candidate).length > maxLength && tail) break;
    tail = candidate;
  }
  return prefix + '…' + tail;
}
