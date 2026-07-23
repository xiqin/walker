'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'src', 'admin', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

test('Admin 静态入口加载五层 CSS 和原生 ES Modules', () => {
  for (const name of ['tokens', 'base', 'layout', 'components', 'responsive']) {
    assert.match(html, new RegExp(`href=["']styles/${name}\\.css["']`));
    assert.ok(fs.existsSync(path.join(publicDir, 'styles', name + '.css')));
  }
  assert.match(html, /<script\s+type=["']module["']>/);
  assert.match(html, /from ['"]\.\/js\/app\.js['"]/);
});

test('Admin 新入口注册四组八个页面并恢复认证目标', () => {
  const pages = ['dashboard', 'sessions', 'activity', 'diagnostics', 'connections', 'config', 'storage', 'tools'];
  for (const page of pages) {
    assert.match(html, new RegExp(`pages/${page}\\.js`), `缺少 ${page} 页面导入`);
    assert.match(html, new RegExp(`\\b${page}\\b`), `缺少 ${page} 页面注册`);
  }
  assert.match(html, /authRecovery\.resume\(runtime\.router\)/);
  assert.match(html, /runtime\?\.router\?\.stop\(\)/);
  assert.match(html, /await runtime\.router\.start\(\)/);
  assert.match(html, /\/api\/admin\/auth\/status/);
  assert.match(html, /\/api\/admin\/auth\/login/);
});

test('Admin 旧根页面实现和样式已移除', () => {
  assert.equal(fs.existsSync(path.join(publicDir, 'app.js')), false);
  assert.equal(fs.existsSync(path.join(publicDir, 'styles.css')), false);
  assert.doesNotMatch(html, /(?:src|href)=["'](?:\.\/)?(?:app\.js|styles\.css)["']/);
});

test('Admin 静态资源引用闭包完整且不引入前端框架', () => {
  const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((ref) => !ref.startsWith('#') && !ref.includes('://'));
  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(publicDir, ref.replace(/^\.\//, ''))), `静态资源不存在: ${ref}`);
  }
  const packageJson = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
  assert.doesNotMatch(packageJson, /"(?:react|vue|vite|redux)"\s*:/i);
  assert.doesNotMatch(html, /react|vue|vite|redux/i);
});

test('Admin 静态源码不包含真实 Secret 或 Secret 环境变量名', () => {
  const files = [];
  function collect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (/\.(?:html|css|js)$/.test(entry.name)) files.push(full);
    }
  }
  collect(publicDir);
  const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(source, /FEISHU_APP_SECRET|WALKER_ADMIN_TOKEN|SECRET_SENTINEL/);
});
