'use strict';

// 只读检查构造边界，不加载测试或驱动，不访问任何数据库。
const fs = require('node:fs');
const path = require('node:path');
const file = path.resolve('test/integration-feishu-tui-sync.test.js');
const source = fs.readFileSync(file, 'utf8');
const constructors = [...source.matchAll(/new OpencodeDriver\(\{/g)];
const missing = constructors.filter((match) => {
  const options = source.slice(match.index + match[0].length, match.index + match[0].length + 100);
  return !/^\s*\.\.\.(?:ctx\.driverOptions|driverOptions|isolatedDriverOptions\(tmpDir\)),/.test(options);
}).map((match) => source.slice(0, match.index).split('\n').length);
console.log(JSON.stringify({ constructors: constructors.length, missing_isolation_lines: missing, passed: missing.length === 0 }));
process.exitCode = missing.length ? 1 : 0;
