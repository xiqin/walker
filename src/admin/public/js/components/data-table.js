import { element } from '../dom.js';

/** 创建具备 caption 和列标题的通用数据表。 */
export function createDataTable(options = {}) {
  const documentRef = options.document || document;
  const table = element('table', { document: documentRef, className: 'data-table' });
  table.append(element('caption', { document: documentRef, text: options.caption || '数据列表' }));
  const headRow = element('tr', { document: documentRef });
  for (const column of options.columns || []) {
    headRow.append(element('th', { document: documentRef, text: column.label, attributes: { scope: 'col' } }));
  }
  table.append(element('thead', { document: documentRef }, headRow));
  const body = element('tbody', { document: documentRef });
  for (const row of options.rows || []) {
    const tableRow = element('tr', { document: documentRef });
    for (const column of options.columns || []) {
      const value = typeof column.render === 'function' ? column.render(row, documentRef) : row[column.key];
      const cell = element('td', { document: documentRef });
      if (value && typeof value === 'object') cell.append(value);
      else cell.textContent = value == null ? '未知' : String(value);
      tableRow.append(cell);
    }
    body.append(tableRow);
  }
  table.append(body);
  return table;
}
