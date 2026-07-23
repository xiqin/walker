import { element } from '../dom.js';
import { formatStatus } from '../format.js';

/** 创建同时使用文字和图标表达状态的摘要卡片。 */
export function createStatusCard(options = {}) {
  const documentRef = options.document || document;
  const status = formatStatus(options.status);
  const card = element('article', { document: documentRef, className: 'status-card status-card--' + status.tone });
  const heading = element('div', { document: documentRef, className: 'status-card__heading' },
    element('h3', { document: documentRef, text: options.title || '状态' }),
    element('span', { document: documentRef, className: 'status-label status-label--' + status.tone, text: status.icon + ' ' + status.label }));
  card.append(heading);
  if (options.description) card.append(element('p', { document: documentRef, className: 'muted', text: options.description }));
  const details = element('dl', { document: documentRef, className: 'status-card__details' });
  for (const [label, value] of options.details || []) {
    details.append(element('dt', { document: documentRef, text: label }), element('dd', { document: documentRef, text: value == null ? '未知' : value }));
  }
  card.append(details);
  return card;
}
