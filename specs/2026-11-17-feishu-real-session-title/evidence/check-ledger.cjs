'use strict';

// 从项目根目录核对账本、持久化测试定位、报告收据和原探针同口径结果。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = process.cwd();
const spec = path.resolve(__dirname, '..');
const ledger = JSON.parse(fs.readFileSync(path.join(spec, 'traceability.json'), 'utf8')).requirements;
const requirements = JSON.parse(fs.readFileSync(path.join(spec, 'requirements.json'), 'utf8')).requirements;
let count = 0;
for (const req of requirements) {
  const entry = ledger[req.id];
  assert.ok(entry && entry.tasks.length && entry.tests.length && entry.evidence.length, req.id);
  for (const behavior of req.behaviors) {
    const mapped = entry.behaviors[behavior.id];
    assert.ok(mapped && mapped.tasks.length && mapped.tests.length && mapped.evidence.length, behavior.id);
    for (const task of mapped.tasks) assert.ok(fs.existsSync(path.join(spec, 'tasks', task + '.md')), task);
    for (const test of mapped.tests) {
      const [file, title] = test.split('#');
      const content = fs.readFileSync(path.join(root, file), 'utf8');
      // 驱动HTTP状态矩阵使用模板生成名称，源码与具体运行名称均保留。
      if (title) {
        const template = title.replace(/^HTTP 401/, 'HTTP ${status}');
        assert.ok(content.includes(title) || content.includes(template), test);
      }
    }
    for (const file of mapped.evidence) assert.ok(fs.existsSync(path.join(root, file)), file);
    count++;
  }
}
const report = fs.readFileSync(path.join(spec, 'test-report.md'), 'utf8');
const receipts = [...report.matchAll(/evidence-file: `([^`]+)`\r?\n- evidence-sha256: `([A-Fa-f0-9]{64})`/g)];
const verified = new Set();
for (const [, file, expected] of receipts) {
  const data = fs.readFileSync(path.join(spec, file));
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  assert.equal(actual.toLowerCase(), expected.toLowerCase(), file);
  verified.add(path.resolve(spec, file));
}
for (const req of Object.values(ledger)) for (const behavior of Object.values(req.behaviors)) {
  for (const evidence of behavior.evidence) assert.ok(verified.has(path.resolve(root, evidence)), evidence);
}
const baseline = JSON.parse(fs.readFileSync(path.join(spec, 'evidence/baseline.json'), 'utf8'));
const fixed = JSON.parse(fs.readFileSync(path.join(spec, 'evidence/fixed.json'), 'utf8'));
assert.equal(baseline.passed, false);
assert.equal(fixed.passed, true);
assert.equal(baseline.expectedTitle, fixed.expectedTitle);
assert.equal(baseline.localTitle, fixed.localTitle);
assert.equal(count, 16);
console.log(JSON.stringify({ requirements: requirements.length, behaviors: count, receipts: receipts.length,
  baseline: baseline.passed, fixed: fixed.passed, passed: true }));
