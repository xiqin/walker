# 连接与集成页面原型还原计划

## 目标
严格按原型还原 connections 页面的 3 个核心区域，同时保留用户要求的额外区域（TUI Bridge/Runtime 卡片、Windows/WSL、TUI Runtime）。

## 原型结构分析

### 1. 外部连接区域（需重写）
- **飞书卡片**: stat-icon(blue ◆) + "飞书（Feishu）长连接" + badge-green "已连接"
  - stat-body: App ID, 事件订阅, Route 模式, 进度样式, 表情回复
  - Buttons: "测试连接" (btn-sm), "断开连接" (btn-sm btn-danger)
- **OpenCode卡片**: stat-icon(purple </>) + "OpenCode Server" + badge-green "正常"
  - stat-body: Server URL, 自动启动, Hook 自动纳入, 健康轮询间隔
  - Buttons: "测试健康检查" (btn-sm), "重装 Plugin" (btn-sm)
- 保留 TUI Bridge 和 Runtime 卡片（使用现有 createStatusCard 样式）

### 2. Agent 扩展区域（需添加操作列）
- Table: Agent, 状态, 说明, 操作
- opencode: "设为默认" link
- claude/codex: "尚未实现" muted link

### 3. Runtime 执行环境区域（需启用编辑）
- 移除 disabled 属性
- select 和 input 可编辑

## 修改文件清单

### 1. `src/admin/public/js/pages/connections.js`
**重写 `renderWorkspace` 函数：**
- 飞书卡片：手动构建 DOM（stat-icon + stat-body rows + buttons），不使用 createStatusCard
- OpenCode卡片：手动构建 DOM（stat-icon + stat-body rows + buttons），不使用 createStatusCard
- TUI Bridge/Runtime 卡片：保留现有 createStatusCard 样式

**修改 `renderAgentTable` 函数：**
- 添加第 4 列 "操作"
- opencode 行："设为默认" link（span.link）
- claude/codex 行："尚未实现" muted link

**修改 `renderRuntimeForm` 函数：**
- 移除 `disabled: 'true'` 属性

### 2. `test/admin-ui-dashboard-connections.test.js`
**更新测试断言：**
- 测试 1: 更新正则匹配新的飞书/OpenCode 卡片内容
- 测试 2-10: 适配新的 DOM 结构

## 实现步骤

1. 重写 connections.js 的 renderWorkspace 函数
2. 修改 renderAgentTable 添加操作列
3. 修改 renderRuntimeForm 启用编辑
4. 更新测试文件适配新结构
5. 运行 ESLint 验证
6. 运行测试验证全部通过

## 风险点
- 飞书卡片需要从 status.feishu 数据中提取 App ID、事件订阅等字段
- OpenCode卡片需要从 agents 数据中提取 Server URL、自动启动等字段
- "测试连接"/"断开连接" 按钮需要新的 API 端点（可能不存在）
- "设为默认" 链接需要新的 API 端点（可能不存在）
