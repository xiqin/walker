'use strict';

const SENSITIVE_KEY_RE = /(token|secret|password|credential|api[_-]?key|app[_-]?secret)/i;

function createOutput(streams) {
  const opts = streams || {};
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  return {
    write(line) { stdout.write(String(sanitize(line)) + '\n'); },
    error(line) { stderr.write(String(sanitize(line)) + '\n'); },
  };
}

function sanitize(value, key) {
  if (value == null) return value;
  if (key && SENSITIVE_KEY_RE.test(String(key))) {
    return value ? '[redacted]' : '';
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (typeof value === 'object') {
    const result = {};
    for (const itemKey of Object.keys(value)) {
      result[itemKey] = sanitize(value[itemKey], itemKey);
    }
    return result;
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/(WALKER_ADMIN_TOKEN|FEISHU_APP_SECRET|TOKEN|SECRET|PASSWORD|API_KEY)=([^\s]+)/gi, '$1=[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\-/]+=*/gi, '$1[redacted]');
}

function formatPresence(value) {
  return value ? 'present' : 'missing';
}

function formatBool(value) {
  return value ? 'yes' : 'no';
}

function section(output, title) {
  output.write('');
  output.write(title);
  output.write('-'.repeat(title.length));
}

function row(output, label, value) {
  output.write(String(label) + '  ' + String(sanitize(value)));
}

function list(output, items) {
  for (const item of items || []) output.write('- ' + sanitize(item));
}

function table(output, headers, rows) {
  const safeHeaders = headers.map(String);
  const safeRows = (rows || []).map((rowValues) => rowValues.map((value) => String(sanitize(value == null ? '' : value))));
  const widths = safeHeaders.map((header, index) => Math.max(header.length, ...safeRows.map((rowValues) => rowValues[index].length)));
  output.write(safeHeaders.map((header, index) => header.padEnd(widths[index])).join('  '));
  output.write(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const rowValues of safeRows) {
    output.write(rowValues.map((value, index) => value.padEnd(widths[index])).join('  '));
  }
}

module.exports = { createOutput, sanitize, formatPresence, formatBool, section, row, list, table };
