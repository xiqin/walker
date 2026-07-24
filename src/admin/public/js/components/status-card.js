import { element } from '../dom.js';
import { formatStatus } from '../format.js';

const TONE_ICON_BG = { success: '#16a34a', warning: '#d97706', danger: '#dc2626', neutral: '#6b7280' };
const TONE_DOT = { success: 'var(--green)', warning: 'var(--amber)', danger: 'var(--red)', neutral: 'var(--text-muted)' };

/** 创建原型风格的统计状态卡片，保留 createStatusCard 文本契约。 */
export function createStatusCard(options = {}) {
  const documentRef = options.document || document;
  const status = formatStatus(options.status);
  const card = element('article', { document: documentRef, className: options.card ? 'card stat-card' : 'stat-card' });
  const iconBg = options.iconColor || TONE_ICON_BG[status.tone] || '#111827';
  const icon = element('div', { document: documentRef, className: 'stat-icon', attributes: { style: `background:${iconBg};` }, text: options.icon || status.icon });
  const head = element('div', { document: documentRef, className: 'stat-head' }, icon,
    element('div', { document: documentRef },
      element('div', { document: documentRef, className: 'stat-name', text: options.title || '状态' }),
      element('div', { document: documentRef, className: 'status-line' },
        element('span', { document: documentRef, className: 'dot', attributes: { style: `background:${TONE_DOT[status.tone] || 'var(--text-muted)'};` } }),
        element('span', { document: documentRef, text: status.label }))));
  card.append(head);
  if (options.description) card.append(element('p', { document: documentRef, className: 'muted', text: options.description }));
  for (const [label, value] of options.details || []) {
    card.append(element('div', { document: documentRef, className: 'stat-body' },
      element('span', { document: documentRef, text: label }),
      element('span', { document: documentRef, text: value == null ? '未知' : value })));
  }
  if (options.foot) card.append(element('div', { document: documentRef, className: 'stat-foot' },
    element('span', { document: documentRef, text: options.foot }),
    element('span', { document: documentRef, text: status.tone === 'warning' ? '⚠' : '✓', attributes: { style: `color:${TONE_DOT[status.tone] || 'var(--text-muted)'};` } })));
  return card;
}
