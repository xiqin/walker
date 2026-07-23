'use strict';

/**
 * 卡片预览模块
 * 返回支持的飞书卡片类型名和不含动态明文的结构预览数据
 * 覆盖未绑定引导、session 列表、可纳入 session、错误卡片和进度卡片类型
 * REQ-021
 */

const {
  renderSessionListCard,
  renderUnboundRouteCard,
  renderAttachableSessionCard,
  renderModelListCard,
  renderHelpCard,
  renderErrorCard,
  buildPermissionCard,
  buildQuestionCard,
  buildQuestionRepliedCard,
} = require('../platform/feishu/cards');

const { ProgressCard } = require('../platform/feishu/progress-card');
const { COMMAND_LIST } = require('../platform/feishu/commands');

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
      requireArray(data.sessions, 'sessions');
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
      requireArray(data.sessions, 'sessions');
      if (data.managedIds != null) requireArray(data.managedIds, 'managedIds');
      return renderAttachableSessionCard(data.sessions || [], { managedIds: data.managedIds || [] });
    },
  },
  {
    name: 'model',
    description: '可用模型列表卡片',
    sampleData: function () {
      return {
        models: [
          { id: 'gpt-5', name: 'GPT-5', provider: 'openai', status: 'available', enabled: true, groups: ['recent'] },
          { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic', status: 'available', enabled: true, groups: ['configured'] },
          { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', status: 'available', enabled: true, groups: [] },
        ],
        currentModel: { providerID: 'openai', modelID: 'gpt-5' },
        routeKey: 'test_route_key',
        page: 1,
      };
    },
    render: function (data) {
      requireArray(data.models, 'models');
      return renderModelListCard(data.models || [], {
        currentModel: data.currentModel,
        routeKey: data.routeKey,
        page: data.page,
      });
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
      if (data.entries != null) requireArray(data.entries, 'entries');
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
  {
    name: 'permission',
    description: '权限确认请求卡片',
    sampleData: function () {
      return {
        permissionEvent: {
          data: {
            id: 'perm_preview_001',
            title: '允许读取项目配置？',
            type: 'read',
            description: 'Agent 请求读取工作区内的配置文件',
            metadata: { tool: 'read', path: '/home/user/project/package.json' },
          },
        },
        sessionId: 'wks_sample_001',
        routeKey: 'test_route_key',
      };
    },
    render: function (data) {
      requireObject(data.permissionEvent, 'permissionEvent');
      return buildPermissionCard(data.permissionEvent || {}, data.sessionId || 'preview_session', data.routeKey);
    },
  },
  {
    name: 'question_confirm',
    description: '交互式问题卡片 - 确认（允许/拒绝）',
    sampleData: function () {
      return {
        questionEvent: {
          data: {
            id: 'q_confirm_001',
            title: '是否允许执行此操作？',
            type: 'question',
            metadata: { inputMode: 'confirm', description: 'Agent 请求执行 shell 命令' },
          },
        },
        sessionId: 'wks_sample_001',
        routeKey: 'test_route_key',
      };
    },
    render: function (data) {
      requireObject(data.questionEvent, 'questionEvent');
      return buildQuestionCard(data.questionEvent, data.sessionId, data.routeKey);
    },
  },
  {
    name: 'question_single_select',
    description: '交互式问题卡片 - 单选',
    sampleData: function () {
      return {
        questionEvent: {
          data: {
            id: 'q_select_001',
            title: '请选择部署环境',
            type: 'question',
            metadata: {
              inputMode: 'single_select',
              description: '请选择目标部署环境',
              options: [
                { label: '开发环境', value: 'dev' },
                { label: '测试环境', value: 'staging' },
                { label: '生产环境', value: 'prod' },
              ],
            },
          },
        },
        sessionId: 'wks_sample_001',
        routeKey: 'test_route_key',
      };
    },
    render: function (data) {
      requireObject(data.questionEvent, 'questionEvent');
      return buildQuestionCard(data.questionEvent, data.sessionId, data.routeKey);
    },
  },
  {
    name: 'question_multi_select',
    description: '交互式问题卡片 - 多选',
    sampleData: function () {
      return {
        questionEvent: {
          data: {
            id: 'q_multi_001',
            title: '请选择要运行的测试套件',
            type: 'question',
            metadata: {
              inputMode: 'multi_select',
              description: '可选择多个测试套件同时运行',
              options: [
                { label: '单元测试', value: 'unit' },
                { label: '集成测试', value: 'integration' },
                { label: '端到端测试', value: 'e2e' },
              ],
            },
          },
        },
        sessionId: 'wks_sample_001',
        routeKey: 'test_route_key',
      };
    },
    render: function (data) {
      requireObject(data.questionEvent, 'questionEvent');
      return buildQuestionCard(data.questionEvent, data.sessionId, data.routeKey);
    },
  },
  {
    name: 'question_text',
    description: '交互式问题卡片 - 文本输入',
    sampleData: function () {
      return {
        questionEvent: {
          data: {
            id: 'q_text_001',
            title: '请输入提交信息',
            type: 'question',
            metadata: { inputMode: 'text', description: '请输入 git commit message' },
          },
        },
        sessionId: 'wks_sample_001',
        routeKey: 'test_route_key',
      };
    },
    render: function (data) {
      requireObject(data.questionEvent, 'questionEvent');
      return buildQuestionCard(data.questionEvent, data.sessionId, data.routeKey);
    },
  },
  {
    name: 'question_replied',
    description: '交互式问题已回复卡片',
    sampleData: function () {
      return { questionId: 'q_confirm_001', answer: 'allow' };
    },
    render: function (data) {
      return buildQuestionRepliedCard(data.questionId, data.answer);
    },
  },
  {
    name: 'question_replied_multi',
    description: '交互式问题已回复卡片（多选答案）',
    sampleData: function () {
      return { questionId: 'q_multi_001', answer: ['unit', 'integration'] };
    },
    render: function (data) {
      return buildQuestionRepliedCard(data.questionId, data.answer);
    },
  },
  {
    name: 'help',
    description: 'Walker 命令帮助卡片',
    sampleData: function () {
      return { commands: COMMAND_LIST, routeKey: 'test_route_key' };
    },
    render: function (data) {
      if (data.commands != null) requireArray(data.commands, 'commands');
      return renderHelpCard(Array.isArray(data.commands) ? data.commands : COMMAND_LIST, { routeKey: data.routeKey });
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
 * @returns {Object|null} 安全渲染结构和预览摘要，未找到类型时返回 null
 */
function previewCard(typeName, customData) {
  var found = CARD_TYPES.find(function (t) { return t.name === typeName; });
  if (!found) return null;

  var isSample = customData == null;
  var data = isSample ? found.sampleData() : customData;
  var rendered = sanitizeCardStructure(found.render(data), '', { allowText: isSample });
  var preview = extractPreview(rendered);

  return {
    typeName: typeName,
    rendered: rendered,
    preview: preview,
  };
}

function badPreviewInput(field, expected) {
  var err = new Error('invalid card preview data: ' + field + ' must be ' + expected);
  err.code = 'BAD_REQUEST';
  return err;
}

function requireArray(value, field) {
  if (value != null && !Array.isArray(value)) throw badPreviewInput(field, 'an array');
}

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badPreviewInput(field, 'an object');
}

var SAFE_STRUCTURE_KEYS = new Set(['schema', 'tag', 'template', 'type', 'width_mode', 'format', 'style']);

function sanitizeCardStructure(value, key, options) {
  var opts = options || {};
  if (typeof value === 'string') {
    if (SAFE_STRUCTURE_KEYS.has(key) && /^[a-z0-9][a-z0-9._-]{0,47}$/i.test(value)) return value;
    if (opts.allowText && isDisplayTextKey(key) && isSafePreviewText(value)) return value;
    return '[REDACTED]';
  }
  if (Array.isArray(value)) {
    return value.map(function (item) { return sanitizeCardStructure(item, '', opts); });
  }
  if (value && typeof value === 'object') {
    var result = {};
    Object.keys(value).forEach(function (name) {
      result[name] = sanitizeCardStructure(value[name], name, opts);
    });
    return result;
  }
  return value;
}

function isDisplayTextKey(key) {
  return key === 'content' || key === 'label' || key === 'placeholder' || key === 'value';
}

function isSafePreviewText(value) {
  return value.length <= 240
    && !/[<>]/.test(value)
    && !/\b(?:secret|token|authorization|cookie|password)\b/i.test(value)
    && !/on[a-z]+\s*=/i.test(value);
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

  var rawElements = rendered.body && rendered.body.elements ? rendered.body.elements : (rendered.elements || []);
  var elements = rawElements.map(function (el) {
    if (el.tag === 'markdown') {
      return { type: 'text', content: el.content || '', format: 'markdown' };
    }
    if (el.tag === 'div' && el.text) {
      return { type: 'text', content: el.text.content || '', format: el.text.tag || 'plain_text' };
    }
    if (el.tag === 'button') {
      return {
        type: 'button',
        label: (el.text && el.text.content) || '',
        style: el.type || 'default',
      };
    }
    if (el.tag === 'form') {
      var formElements = (el.elements || []).map(function (sub) {
        if (sub.tag === 'button') {
          return {
            type: 'button',
            label: (sub.text && sub.text.content) || '',
            style: sub.type || 'default',
          };
        }
        if (sub.tag === 'multi_select_static' || sub.tag === 'select_static') {
          return {
            type: sub.tag,
            name: sub.name || '',
            optionCount: (sub.options || []).length,
            options: (sub.options || []).map(function (opt) {
              return { label: (opt.text && opt.text.content) || '', value: opt.value || '' };
            }),
          };
        }
        if (sub.tag === 'input') {
          return {
            type: 'input',
            name: sub.name || '',
            placeholder: (sub.placeholder && sub.placeholder.content) || '',
          };
        }
        if (sub.tag === 'checker') {
          return {
            type: 'checker',
            label: (sub.text && sub.text.content) || '',
            checked: !!sub.checked,
          };
        }
        return { type: sub.tag || 'unknown' };
      });
      return { type: 'form', actions: formElements };
    }
    if (el.tag === 'action') {
      var actions = (el.actions || []).map(function (act) {
        if (act.tag === 'button') {
          return {
            type: 'button',
            label: (act.text && act.text.content) || '',
            style: act.type || 'default',
          };
        }
        if (act.tag === 'multi_select_static') {
          return {
            type: 'multi_select_static',
            name: act.name || '',
            optionCount: (act.options || []).length,
            options: (act.options || []).map(function (opt) {
              return { label: (opt.text && opt.text.content) || '', value: opt.value || '' };
            }),
          };
        }
        if (act.tag === 'input') {
          return {
            type: 'input',
            name: act.name || '',
            placeholder: (act.placeholder && act.placeholder.content) || '',
          };
        }
        return { type: act.tag || 'unknown' };
      });
      return { type: 'action', actions: actions };
    }
    if (el.tag === 'column_set') {
      var colButtons = [];
      (el.columns || []).forEach(function (col) {
        (col.elements || []).forEach(function (sub) {
          if (sub.tag === 'button') {
            colButtons.push({
              type: 'button',
              label: (sub.text && sub.text.content) || '',
              style: sub.type || 'default',
            });
          }
        });
      });
      if (colButtons.length > 0) {
        return { type: 'action', actions: colButtons };
      }
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
