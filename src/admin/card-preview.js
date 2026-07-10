'use strict';

/**
 * 卡片预览模块
 * 返回支持的飞书卡片类型名、示例数据 JSON 和简化视觉预览数据
 * 覆盖未绑定引导、session 列表、可纳入 session、错误卡片和进度卡片类型
 * REQ-021
 */

const {
  renderSessionListCard,
  renderUnboundRouteCard,
  renderAttachableSessionCard,
  renderErrorCard,
} = require('../platform/feishu/cards');

const { ProgressCard } = require('../platform/feishu/progress-card');

/** 卡片类型定义表：名称、描述、示例数据生成函数和渲染函数 */
const CARD_TYPES = [
  {
    name: 'unbound_route',
    description: '未绑定会话的引导卡片',
    sampleData: function () {
      return { routeKey: 'test_route_key' };
    },
    render: function (data) {
      return renderUnboundRouteCard(data.routeKey || 'default_route');
    },
  },
  {
    name: 'session_list',
    description: '会话列表卡片',
    sampleData: function () {
      return {
        sessions: [
          { id: 'wks_sample_001', title: '示例会话', agent: 'opencode', cwd: '/home/user/project', status: 'idle', updatedAt: Date.now() },
          { id: 'wks_sample_002', title: '测试会话', agent: 'opencode', cwd: '/home/user/test', status: 'running', updatedAt: Date.now() },
        ],
        currentSessionId: 'wks_sample_001',
      };
    },
    render: function (data) {
      return renderSessionListCard(data.sessions || [], data.currentSessionId || null);
    },
  },
  {
    name: 'attachable_session',
    description: '可纳入的 OpenCode 会话卡片',
    sampleData: function () {
      return {
        sessions: [
          { id: 'oc_sample_001', title: 'OpenCode 会话', cwd: '/home/user/app', status: 'idle' },
        ],
        managedIds: [],
      };
    },
    render: function (data) {
      return renderAttachableSessionCard(data.sessions || [], { managedIds: data.managedIds || [] });
    },
  },
  {
    name: 'error',
    description: '错误提示卡片',
    sampleData: function () {
      return { message: '发生了一个错误：连接超时' };
    },
    render: function (data) {
      return renderErrorCard(data.message || '未知错误');
    },
  },
  {
    name: 'progress',
    description: '进度卡片（追踪 Agent 处理过程）',
    sampleData: function () {
      return {
        sessionId: 'wks_sample_001',
        phase: 'working',
        entries: ['🤔 正在分析代码...', '🔧 读取文件 ✓', '🔧 修改代码 ⏳'],
      };
    },
    render: function (data) {
      var card = new ProgressCard({ sessionId: data.sessionId || 'preview_session' });
      if (data.phase === 'done') {
        card.phase = 'done';
        card.done = true;
      } else if (data.phase === 'error') {
        card.phase = 'error';
      } else if (data.phase === 'working') {
        card.phase = 'working';
      }
      card.entries = data.entries || [];
      return card.render();
    },
  },
];

/**
 * 获取所有支持的卡片类型列表（名称和描述）
 * @returns {Object[]} 卡片类型数组，每项含 name 和 description
 */
function listCardTypes() {
  return CARD_TYPES.map(function (t) {
    return { name: t.name, description: t.description };
  });
}

/**
 * 获取指定卡片类型的示例数据
 * @param {string} typeName - 卡片类型名称
 * @returns {Object|null} 示例数据对象，未找到类型时返回 null
 */
function getSampleData(typeName) {
  var found = CARD_TYPES.find(function (t) { return t.name === typeName; });
  if (!found) return null;
  return found.sampleData();
}

/**
 * 渲染指定卡片类型的预览，使用示例数据或传入的数据
 * @param {string} typeName - 卡片类型名称
 * @param {Object} [customData] - 自定义数据，未传入时使用示例数据
 * @returns {Object|null} 渲染结果和预览摘要，未找到类型时返回 null
 */
function previewCard(typeName, customData) {
  var found = CARD_TYPES.find(function (t) { return t.name === typeName; });
  if (!found) return null;

  var data = customData || found.sampleData();
  var rendered = found.render(data);

  var preview = extractPreview(rendered);

  return {
    typeName: typeName,
    data: data,
    rendered: rendered,
    preview: preview,
  };
}

/**
 * 从飞书卡片 JSON 结构中提取简化视觉预览数据
 * @param {Object} rendered - 飞书卡片 JSON 结构
 * @returns {Object} 简化预览对象含 header、elements 摘要
 */
function extractPreview(rendered) {
  var header = rendered.header || {};
  var headerTitle = (header.title && header.title.content) || '';
  var headerTemplate = header.template || 'default';

  var elements = (rendered.elements || []).map(function (el) {
    if (el.tag === 'div' && el.text) {
      return { type: 'text', content: el.text.content || '', format: el.text.tag || 'plain_text' };
    }
    if (el.tag === 'action') {
      var buttons = (el.actions || []).map(function (btn) {
        return {
          type: 'button',
          label: (btn.text && btn.text.content) || '',
          style: btn.type || 'default',
        };
      });
      return { type: 'action', buttons: buttons };
    }
    if (el.tag === 'column_set') {
      return { type: 'columns' };
    }
    return { type: el.tag || 'unknown' };
  });

  return {
    header: { title: headerTitle, template: headerTemplate },
    elementCount: elements.length,
    elements: elements,
  };
}

module.exports = { listCardTypes, getSampleData, previewCard, extractPreview, CARD_TYPES };
