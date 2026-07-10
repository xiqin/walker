'use strict';

/**
 * 静态 SPA 控制台内容与关键约束测试
 * 覆盖 REQ-002 ~ REQ-026
 * 读取 HTML/CSS/JS 静态文件，断言导航、视图、API endpoint、确认文案、响应式规则和 secret 防护
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'src', 'admin', 'public');

/**
 * 读取静态文件内容，失败时返回空字符串
 * @param {string} filename - 文件名
 * @returns {string}
 */
function readStatic(filename) {
  const filePath = path.join(publicDir, filename);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return '';
  }
}

const html = readStatic('index.html');
const css = readStatic('styles.css');
const js = readStatic('app.js');

/* ============================================================
 * REQ-002: Token 模式下展示登录界面
 * ============================================================ */
test('HTML 包含登录界面元素', () => {
  assert.ok(html.includes('id="login"'), '缺少 id="login" 登录区域');
  assert.ok(html.includes('type="password"'), '缺少密码输入框');
  assert.ok(html.includes('登录'), '缺少登录按钮文案');
});

test('JS 包含 auth/status 和 auth/login API 路径', () => {
  assert.ok(js.includes('/api/admin/auth/status'), '缺少 auth/status 路径');
  assert.ok(js.includes('/api/admin/auth/login'), '缺少 auth/login 路径');
});

/* ============================================================
 * REQ-003: 总览 Dashboard
 * ============================================================ */
test('HTML 包含总览导航项和视图', () => {
  assert.ok(html.includes('#overview') || js.includes('#overview'), '缺少总览导航 #overview');
  assert.ok(js.includes('overview'), 'JS 缺少 overview 视图渲染');
});

test('JS 包含 overview API 路径', () => {
  assert.ok(js.includes('/api/admin/overview'), '缺少 /api/admin/overview 路径');
});

/* ============================================================
 * REQ-004: Session 列表与详情
 * ============================================================ */
test('HTML 包含 Sessions 导航项', () => {
  assert.ok(html.includes('#sessions') || js.includes('#sessions'), '缺少 Sessions 导航 #sessions');
});

test('JS 包含 sessions API 路径', () => {
  assert.ok(js.includes('/api/admin/sessions'), '缺少 /api/admin/sessions 路径');
});

/* ============================================================
 * REQ-005: Session 创建表单
 * ============================================================ */
test('JS 包含 session 创建相关字段', () => {
  assert.ok(js.includes('agent'), '缺少 agent 字段');
  assert.ok(js.includes('title'), '缺少 title 字段');
  assert.ok(js.includes('runtime'), '缺少 runtime 字段');
  assert.ok(js.includes('cwd'), '缺少 cwd 字段');
  assert.ok(js.includes('createAgentSession'), '缺少 createAgentSession 字段');
});

/* ============================================================
 * REQ-006: 停止和删除操作带确认
 * ============================================================ */
test('JS 包含停止和删除确认文案', () => {
  assert.ok(js.includes('确认停止'), '缺少确认停止文案');
  assert.ok(js.includes('确认删除'), '缺少确认删除文案');
});

test('JS 包含 session stop 和 delete API 路径', () => {
  assert.ok(js.includes('/stop'), '缺少 /stop 路径');
  assert.ok(js.includes('/api/admin/sessions'), '缺少 sessions API 路径');
});

/* ============================================================
 * REQ-007: 路由绑定管理
 * ============================================================ */
test('HTML 包含路由导航项', () => {
  assert.ok(html.includes('#routes') || js.includes('#routes'), '缺少路由导航 #routes');
});

test('JS 包含 routes API 路径', () => {
  assert.ok(js.includes('/api/admin/routes'), '缺少 /api/admin/routes 路径');
  assert.ok(js.includes('cleanup-dangling'), '缺少 cleanup-dangling 路径');
});

/* ============================================================
 * REQ-008: 悬空绑定诊断与清理
 * ============================================================ */
test('JS 包含 dangling route 清理入口', () => {
  assert.ok(js.includes('cleanup-dangling') || js.includes('dangling'), '缺少 dangling 清理入口');
  assert.ok(js.includes('确认清理') || js.includes('确认'), '缺少清理确认文案');
});

/* ============================================================
 * REQ-009: Agent Driver 管理
 * ============================================================ */
test('HTML 包含 Agent 导航项', () => {
  assert.ok(html.includes('#agents') || js.includes('#agents'), '缺少 Agent 导航 #agents');
});

test('JS 包含 agents API 路径', () => {
  assert.ok(js.includes('/api/admin/agents'), '缺少 /api/admin/agents 路径');
});

/* ============================================================
 * REQ-010: OpenCode 健康检查与自启
 * ============================================================ */
test('JS 包含 agent check 和 ensure-ready API 路径', () => {
  assert.ok(js.includes('/check'), '缺少 /check 路径');
  assert.ok(js.includes('/ensure-ready'), '缺少 /ensure-ready 路径');
  assert.ok(js.includes('/api/admin/agents'), '缺少 /api/admin/agents 路径');
});

/* ============================================================
 * REQ-011: Runtime 管理
 * ============================================================ */
test('HTML 包含 Runtime 导航项', () => {
  assert.ok(html.includes('#runtime') || js.includes('#runtime'), '缺少 Runtime 导航 #runtime');
});

test('JS 包含 runtime API 路径', () => {
  assert.ok(js.includes('/api/admin/runtime'), '缺少 /api/admin/runtime 路径');
});

/* ============================================================
 * REQ-012: 配置查看与安全编辑（secret 脱敏）
 * ============================================================ */
test('HTML 包含配置导航项', () => {
  assert.ok(html.includes('#config') || js.includes('#config'), '缺少配置导航 #config');
});

test('JS 包含 config API 路径', () => {
  assert.ok(js.includes('/api/admin/config'), '缺少 /api/admin/config 路径');
});

test('JS 不渲染 secret 明文', () => {
  assert.ok(!js.includes('FEISHU_APP_SECRET'), 'JS 中不应出现 FEISHU_APP_SECRET 明文');
  assert.ok(!js.includes('WALKER_ADMIN_TOKEN'), 'JS 中不应出现 WALKER_ADMIN_TOKEN 明文');
});

test('JS 包含 secret 脱敏逻辑', () => {
  assert.ok(js.includes('********') || js.includes('maskSecret') || js.includes('mask'), '缺少 secret 脱敏逻辑');
});

/* ============================================================
 * REQ-013: 日志查看
 * ============================================================ */
test('HTML 包含日志导航项', () => {
  assert.ok(html.includes('#logs') || js.includes('#logs'), '缺少日志导航 #logs');
});

test('JS 包含 logs API 路径', () => {
  assert.ok(js.includes('/api/admin/logs'), '缺少 /api/admin/logs 路径');
});

/* ============================================================
 * REQ-014: 事件查看
 * ============================================================ */
test('JS 包含 events API 路径', () => {
  assert.ok(js.includes('/api/admin/events'), '缺少 /api/admin/events 路径');
});

/* ============================================================
 * REQ-015: 附件管理
 * ============================================================ */
test('HTML 包含附件导航项', () => {
  assert.ok(html.includes('#attachments') || js.includes('#attachments'), '缺少附件导航 #attachments');
});

test('JS 包含 attachments API 路径', () => {
  assert.ok(js.includes('/api/admin/attachments'), '缺少 /api/admin/attachments 路径');
});

/* ============================================================
 * REQ-016: 会话时间线
 * ============================================================ */
test('JS 包含 timeline API 路径', () => {
  assert.ok(js.includes('/timeline'), '缺少 /timeline 路径');
});

/* ============================================================
 * REQ-017: 手动发送 Prompt
 * ============================================================ */
test('JS 包含 prompt API 路径', () => {
  assert.ok(js.includes('/prompt'), '缺少 /prompt 路径');
});

/* ============================================================
 * REQ-018: 健康检查页
 * ============================================================ */
test('HTML 包含诊断导航项', () => {
  assert.ok(html.includes('#diagnostics') || js.includes('#diagnostics'), '缺少诊断导航 #diagnostics');
});

test('JS 包含 health API 路径', () => {
  assert.ok(js.includes('/api/admin/health'), '缺少 /api/admin/health 路径');
});

/* ============================================================
 * REQ-019: 数据维护工具
 * ============================================================ */
test('HTML 包含维护导航项', () => {
  assert.ok(html.includes('#maintenance') || js.includes('#maintenance'), '缺少维护导航 #maintenance');
});

test('JS 包含 maintenance API 路径', () => {
  assert.ok(js.includes('/api/admin/export'), '缺少 /api/admin/export 路径');
  assert.ok(js.includes('/api/admin/backup'), '缺少 /api/admin/backup 路径');
  assert.ok(js.includes('/api/admin/cleanup'), '缺少 /api/admin/cleanup 路径');
});

/* ============================================================
 * REQ-020: 飞书命令模拟器
 * ============================================================ */
test('HTML 包含工具导航项', () => {
  assert.ok(html.includes('#tools') || js.includes('#tools'), '缺少工具导航 #tools');
});

test('JS 包含 command-simulate API 路径', () => {
  assert.ok(js.includes('/command-simulate'), '缺少 /command-simulate 路径');
});

/* ============================================================
 * REQ-021: 卡片预览
 * ============================================================ */
test('JS 包含 cards API 路径', () => {
  assert.ok(js.includes('/cards'), '缺少 /cards 路径');
  assert.ok(js.includes('/preview'), '缺少 /preview 路径');
});

/* ============================================================
 * REQ-022: 多 Agent 扩展配置
 * ============================================================ */
test('JS 包含扩展 driver 展示逻辑', () => {
  assert.ok(js.includes('available') || js.includes('reason'), '缺少扩展 driver 状态展示逻辑');
});

/* ============================================================
 * REQ-023: 指标趋势
 * ============================================================ */
test('HTML 包含指标导航项', () => {
  assert.ok(html.includes('#metrics') || js.includes('#metrics'), '缺少指标导航 #metrics');
});

test('JS 包含 metrics API 路径', () => {
  assert.ok(js.includes('/api/admin/metrics'), '缺少 /api/admin/metrics 路径');
});

/* ============================================================
 * REQ-024: 服务停止二次确认
 * ============================================================ */
test('JS 包含服务停止确认文案', () => {
  assert.ok(js.includes('确认停止服务') || js.includes('服务将停止'), '缺少服务停止确认文案');
});

test('JS 包含 service/stop API 路径', () => {
  assert.ok(js.includes('/api/admin/service/stop'), '缺少 /api/admin/service/stop 路径');
});

/* ============================================================
 * REQ-025: 响应式布局
 * ============================================================ */
test('CSS 包含 390px 响应式断点', () => {
  assert.ok(css.includes('390px'), '缺少 390px 响应式断点');
  assert.ok(css.includes('@media'), '缺少 @media 规则');
});

test('CSS 包含左侧导航和紧凑布局样式', () => {
  assert.ok(css.includes('nav') || css.includes('sidebar'), '缺少导航样式');
  assert.ok(css.includes('200px') || css.includes('200'), '缺少 200px 导航宽度');
});

test('CSS 包含危险操作红色样式', () => {
  assert.ok(css.includes('danger') || css.includes('red'), '缺少危险操作样式');
});

test('CSS 包含 secret 脱敏样式', () => {
  assert.ok(css.includes('secret') || css.includes('masked'), '缺少 secret 脱敏样式');
});

/* ============================================================
 * REQ-026: 静态 UI 测试可独立运行
 * ============================================================ */
test('HTML 文件存在且非空', () => {
  assert.ok(html.length > 0, 'index.html 为空或不存在');
});

test('CSS 文件存在且非空', () => {
  assert.ok(css.length > 0, 'styles.css 为空或不存在');
});

test('JS 文件存在且非空', () => {
  assert.ok(js.length > 0, 'app.js 为空或不存在');
});

test('HTML 包含应用挂载点 div#app', () => {
  assert.ok(html.includes('id="app"'), '缺少 id="app" 挂载点');
});

test('HTML 引用 styles.css 和 app.js', () => {
  assert.ok(html.includes('styles.css'), 'HTML 未引用 styles.css');
  assert.ok(html.includes('app.js'), 'HTML 未引用 app.js');
});

/* ============================================================
 * 综合断言：所有导航视图
 * ============================================================ */
test('HTML 包含所有导航项', () => {
  const navItems = ['总览', 'Sessions', '路由', 'Agent', 'Runtime', '日志', '附件', '配置', '诊断', '维护', '工具', '指标'];
  for (const item of navItems) {
    assert.ok(html.includes(item) || js.includes(item), '缺少导航项: ' + item);
  }
});

test('JS 包含所有 hash 路由', () => {
  const routes = ['#overview', '#sessions', '#routes', '#agents', '#runtime', '#logs', '#attachments', '#config', '#diagnostics', '#maintenance', '#tools', '#metrics'];
  for (const route of routes) {
    assert.ok(js.includes(route), '缺少 hash 路由: ' + route);
  }
});

test('JS 包含所有 API endpoint 路径', () => {
  const endpoints = [
    '/api/admin/auth/status',
    '/api/admin/auth/login',
    '/api/admin/overview',
    '/api/admin/sessions',
    '/api/admin/routes',
    '/api/admin/routes/cleanup-dangling',
    '/api/admin/agents',
    '/api/admin/runtime',
    '/api/admin/config',
    '/api/admin/logs',
    '/api/admin/events',
    '/api/admin/metrics',
    '/api/admin/attachments',
    '/api/admin/export',
    '/api/admin/backup',
    '/api/admin/cleanup',
    '/api/admin/health',
    '/api/admin/tools/command-simulate',
    '/api/admin/tools/cards',
    '/api/admin/tools/cards/preview',
    '/api/admin/service/stop',
  ];
  for (const ep of endpoints) {
    assert.ok(js.includes(ep), '缺少 API endpoint: ' + ep);
  }
});
