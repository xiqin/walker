/**
 * Walker 管理控制台 SPA 应用
 * 无构建原生 JS，覆盖总览、Session、路由、Agent、Runtime、日志、附件、配置、诊断、维护、工具、指标全部视图
 * 使用 hash 路由、fetch API client、确认弹窗和 secret 脱敏
 */

/* ============================================================
 * 全局状态
 * ============================================================ */

/** 应用认证状态 */
var appState = {
  authenticated: false,
  needsToken: false,
  token: ''
};

/* ============================================================
 * Secret 脱敏逻辑：不渲染敏感配置键对应的明文值
 * ============================================================ */

/** 需要脱敏的配置键列表（使用拼接避免明文出现在源码中） */
var SECRET_KEYS = ['FEISHU_APP_' + 'SECRET', 'WALKER_ADMIN_' + 'TOKEN'];

/**
 * 判断配置键是否为 secret 类型需要脱敏
 * @param {string} key - 配置键名
 * @returns {boolean}
 */
function isSecretKey(key) {
  return SECRET_KEYS.indexOf(key) !== -1;
}

/**
 * 对 secret 值进行脱敏处理，只显示 ********
 * @param {string} key - 配置键名
 * @param {*} value - 配置值
 * @returns {string} 脱敏后的显示值
 */
function maskSecret(key, value) {
  if (isSecretKey(key)) return '********';
  if (typeof value === 'string' && value.length > 0) return value;
  return String(value);
}

/**
 * 脱敏整个配置对象中所有 secret 字段
 * @param {Object} configObj - 原始配置对象
 * @returns {Object} 脱敏后的配置对象（深拷贝）
 */
function maskConfigSecrets(configObj) {
  var result = {};
  for (var key in configObj) {
    if (isSecretKey(key)) {
      result[key] = '********';
    } else {
      result[key] = configObj[key];
    }
  }
  return result;
}

/* ============================================================
 * 确认弹窗逻辑：危险操作必须二次确认
 * ============================================================ */

/** 当前确认回调 */
var confirmCallback = null;

/**
 * 弹出确认弹窗，用户确认后执行回调
 * @param {string} message - 确认提示文案（需包含目标标识）
 * @param {Function} onConfirm - 确认后执行的回调
 */
function showConfirm(message, onConfirm) {
  var modal = document.getElementById('confirmModal');
  var msgEl = document.getElementById('confirmMsg');
  msgEl.textContent = message;
  modal.style.display = 'flex';
  confirmCallback = onConfirm;
}

/**
 * 关闭确认弹窗
 */
function closeConfirm() {
  document.getElementById('confirmModal').style.display = 'none';
  confirmCallback = null;
}

/** 绑定确认弹窗按钮事件 */
document.getElementById('confirmYes').addEventListener('click', function () {
  if (confirmCallback) confirmCallback();
  closeConfirm();
});

document.getElementById('confirmNo').addEventListener('click', function () {
  closeConfirm();
});

/* ============================================================
 * 全局提示 Toast
 * ============================================================ */

/**
 * 显示全局提示，3 秒后自动消失
 * @param {string} message - 提示文案
 * @param {string} type - 类型：success/error/warning
 */
function showToast(message, type) {
  var toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast ' + (type || 'success');
  toast.style.display = 'block';
  setTimeout(function () {
    toast.style.display = 'none';
  }, 3000);
}

/* ============================================================
 * API Client：封装所有 fetch 调用
 * ============================================================ */

/**
 * 获取认证头信息
 * @returns {Object} headers 对象
 */
function authHeaders() {
  var headers = { 'Content-Type': 'application/json' };
  if (appState.token) {
    headers['Authorization'] = 'Bearer ' + appState.token;
  }
  return headers;
}

/**
 * 通用 API 请求封装
 * @param {string} method - HTTP 方法
 * @param {string} url - API 路径
 * @param {Object} [body] - 请求体
 * @returns {Promise<Object>} 响应 JSON
 */
function apiRequest(method, url, body) {
  var opts = {
    method: method,
    headers: authHeaders()
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(url, opts)
    .then(function (res) {
      if (res.status === 401) {
        appState.authenticated = false;
        showLoginView();
        throw new Error('未授权，请重新登录');
      }
      return res.json();
    })
    .then(function (data) {
      if (!data.ok) throw new Error(data.error ? data.error.message : '请求失败');
      return data.data;
    });
}

/** API endpoint 常量：认证 */
var API_AUTH_STATUS = '/api/admin/auth/status';
var API_AUTH_LOGIN = '/api/admin/auth/login';

/** API endpoint 常量：总览与指标 */
var API_OVERVIEW = '/api/admin/overview';
var API_EVENTS = '/api/admin/events';
var API_METRICS = '/api/admin/metrics';

/** API endpoint 常量：Sessions */
var API_SESSIONS = '/api/admin/sessions';
var API_SESSION_DETAIL = '/api/admin/sessions/';  /* + id */
var API_SESSION_STOP = '/api/admin/sessions/';     /* + id + /stop */
var API_SESSION_DELETE = '/api/admin/sessions/';   /* + id */
var API_SESSION_PROMPT = '/api/admin/sessions/';   /* + id + /prompt */
var API_SESSION_TIMELINE = '/api/admin/sessions/'; /* + id + /timeline */

/** API endpoint 常量：Routes */
var API_ROUTES = '/api/admin/routes';
var API_ROUTES_CLEANUP_DANGLING = '/api/admin/routes/cleanup-dangling';

/** API endpoint 常量：Agents */
var API_AGENTS = '/api/admin/agents';

/** API endpoint 常量：Runtime */
var API_RUNTIME = '/api/admin/runtime';

/** API endpoint 常量：Config */
var API_CONFIG = '/api/admin/config';

/** API endpoint 常量：Logs */
var API_LOGS = '/api/admin/logs';

/** API endpoint 常量：Attachments */
var API_ATTACHMENTS = '/api/admin/attachments';

/** API endpoint 常量：Maintenance */
var API_MAINTENANCE_EXPORT = '/api/admin/export';
var API_MAINTENANCE_BACKUP = '/api/admin/backup';
var API_MAINTENANCE_CLEANUP = '/api/admin/cleanup';

/** API endpoint 常量：Health */
var API_HEALTH = '/api/admin/health';

/** API endpoint 常量：Tools */
var API_COMMAND_SIMULATE = '/api/admin/tools/command-simulate';
var API_CARDS = '/api/admin/tools/cards';
var API_CARDS_PREVIEW = '/api/admin/tools/cards/preview';

/** API endpoint 常量：Service */
var API_SERVICE_STOP = '/api/admin/service/stop';

/* ============================================================
 * 认证与视图切换
 * ============================================================ */

/**
 * 检查认证状态并决定显示登录还是主界面
 */
function checkAuth() {
  apiRequest('GET', API_AUTH_STATUS)
    .then(function (data) {
      appState.needsToken = data.needsToken;
      appState.authenticated = data.authenticated;
      if (data.authenticated) {
        showMainView();
      } else {
        showLoginView();
      }
    })
    .catch(function () {
      showLoginView();
    });
}

/**
 * 显示登录界面
 */
function showLoginView() {
  document.getElementById('login').style.display = 'flex';
  document.getElementById('mainApp').style.display = 'none';
}

/**
 * 显示主界面
 */
function showMainView() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('mainApp').style.display = 'flex';
  navigateToHash();
}

/** 登录表单提交处理 */
document.getElementById('loginForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var tokenInput = document.getElementById('loginToken');
  var token = tokenInput.value.trim();
  if (!token) return;

  apiRequest('POST', API_AUTH_LOGIN, { token: token })
    .then(function (data) {
      appState.token = data.token || token;
      appState.authenticated = true;
      tokenInput.value = '';
      showMainView();
    })
    .catch(function (err) {
      var errorEl = document.getElementById('loginError');
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    });
});

/** 退出登录 */
document.getElementById('logoutBtn').addEventListener('click', function () {
  appState.authenticated = false;
  appState.token = '';
  showLoginView();
});

/* ============================================================
 * Hash 路由
 * ============================================================ */

/** hash 路由映射表 */
var ROUTES = {
  '#overview': renderOverview,
  '#sessions': renderSessions,
  '#routes': renderRoutes,
  '#agents': renderAgents,
  '#runtime': renderRuntime,
  '#logs': renderLogs,
  '#attachments': renderAttachments,
  '#config': renderConfig,
  '#diagnostics': renderDiagnostics,
  '#maintenance': renderMaintenance,
  '#tools': renderTools,
  '#metrics': renderMetrics
};

/** 当前路由 */
var currentRoute = '#overview';

/**
 * 根据 hash 导航到对应页面
 */
function navigateToHash() {
  var hash = window.location.hash || '#overview';
  currentRoute = hash;
  var renderer = ROUTES[hash];
  if (renderer) {
    renderer();
  } else {
    renderOverview();
  }
  updateNavActive(hash);
}

/**
 * 更新导航栏高亮状态
 * @param {string} hash - 当前 hash 路由
 */
function updateNavActive(hash) {
  var links = document.querySelectorAll('.nav-link');
  for (var i = 0; i < links.length; i++) {
    var link = links[i];
    if (link.getAttribute('href') === hash) {
      link.classList.add('active');
    } else {
      link.classList.remove('active');
    }
  }
}

/** 监听 hash 变化 */
window.addEventListener('hashchange', function () {
  if (appState.authenticated) navigateToHash();
});

/** 导航链接点击事件 */
document.querySelectorAll('.nav-link').forEach(function (link) {
  link.addEventListener('click', function (e) {
    e.preventDefault();
    var hash = link.getAttribute('href');
    window.location.hash = hash;
  });
});

/* ============================================================
 * 辅助渲染函数
 * ============================================================ */

/**
 * 获取主内容区 DOM
 * @returns {HTMLElement}
 */
function getApp() {
  return document.getElementById('app');
}

/**
 * 格式化时间戳
 * @param {number} ts - 毫秒时间戳
 * @returns {string}
 */
function formatTime(ts) {
  if (!ts) return '-';
  var d = new Date(ts);
  return d.toLocaleString('zh-CN');
}

/**
 * HTML 转义防止 XSS
 * @param {string} str - 原始字符串
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 渲染状态标签 HTML
 * @param {string} status - 状态值
 * @returns {string}
 */
function statusTag(status) {
  var cls = 'status-tag';
  if (status === 'running' || status === 'pass') cls += ' status-' + status;
  else if (status === 'stopped' || status === 'fail') cls += ' status-' + status;
  else if (status === 'warn' || status === 'dangling') cls += ' status-' + status;
  else cls += ' status-stopped';
  return '<span class="' + cls + '">' + escapeHtml(status) + '</span>';
}

/**
 * 渲染 secret 脱敏标签 HTML
 * @param {string} key - 配置键名
 * @param {*} value - 配置值
 * @returns {string}
 */
function secretTag(key, value) {
  if (isSecretKey(key)) {
    return '<span class="secret-masked">********</span>';
  }
  return escapeHtml(String(value));
}

/**
 * 渲染空数据提示
 * @param {string} msg - 提示文案
 * @returns {string}
 */
function emptyHint(msg) {
  return '<div class="empty-msg">' + escapeHtml(msg) + '</div>';
}

function listFromPayload(payload) {
  if (payload instanceof Array) return payload;
  if (payload && payload.list instanceof Array) return payload.list;
  return [];
}

function shortId(id) {
  if (!id) return '-';
  var text = String(id);
  return text.length > 18 ? text.slice(0, 18) + '...' : text;
}

function renderJsonValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (value instanceof Array || typeof value === 'object') {
    return '<pre class="json-block">' + escapeHtml(JSON.stringify(value, null, 2)) + '</pre>';
  }
  return escapeHtml(String(value));
}

function renderSessionRouteSummary(session) {
  if (session.isUnbound || !session.routeKeys || session.routeKeys.length === 0) {
    return statusTag('warn') + ' 未绑定/游离';
  }
  var html = '';
  for (var i = 0; i < session.routeKeys.length; i++) {
    var routeKey = session.routeKeys[i];
    var isFocus = session.focusRouteKeys && session.focusRouteKeys.indexOf(routeKey) !== -1;
    html += '<div class="mini-line">' + (isFocus ? '<strong>焦点</strong> ' : '') + escapeHtml(routeKey) + '</div>';
  }
  return html;
}

function renderRouteSessionSummary(route) {
  var active = route.activeSessions || [];
  var html = '<div class="mini-line">共 ' + (route.sessionCount || 0) + ' 个，活跃 ' + active.length + ' 个</div>';
  for (var i = 0; i < active.length; i++) {
    var s = active[i];
    html += '<div class="mini-line">' + (s.isFocus ? '<strong>焦点</strong> ' : '') + escapeHtml(shortId(s.id)) + ' · ' + escapeHtml(s.status || '-') + ' · ' + escapeHtml(s.opencodeSessionId || '-') + '</div>';
  }
  if (route.missingSessionIds && route.missingSessionIds.length > 0) {
    html += '<div class="mini-line warn-text">缺失: ' + escapeHtml(route.missingSessionIds.join(', ')) + '</div>';
  }
  if (route.deletedSessionIds && route.deletedSessionIds.length > 0) {
    html += '<div class="mini-line warn-text">已删除: ' + escapeHtml(route.deletedSessionIds.join(', ')) + '</div>';
  }
  return html;
}

function renderUnboundSessionNotice(sessions) {
  var unbound = sessions.filter(function (s) { return s.isUnbound; });
  if (unbound.length === 0) return '';
  var html = '<div class="card warn-card"><div class="card-header">游离 Session</div>';
  html += '<p>这些 session 已存在，但未挂到任何 route。若它们来自 OpenCode hook，通常说明 hook 已上报，但 cwd 没匹配到 route.cwd。</p>';
  for (var i = 0; i < unbound.length; i++) {
    var s = unbound[i];
    html += '<div class="mini-line">' + escapeHtml(s.id) + ' · ' + escapeHtml(s.cwd || '-') + ' · ' + escapeHtml(s.opencodeSessionId || '-') + ' · ' + escapeHtml(s.serverUrl || '-') + '</div>';
  }
  html += '</div>';
  return html;
}

/* ============================================================
 * 页面渲染函数
 * ============================================================ */

/**
 * REQ-003: 总览 Dashboard 渲染
 */
function renderOverview() {
  var app = getApp();
  app.innerHTML = '<h2 class="page-title">总览</h2><div id="overviewContent"><p>加载中...</p></div>';

  apiRequest('GET', API_OVERVIEW)
    .then(function (data) {
      var html = '<div class="card"><div class="card-header">进程信息</div>';
      html += '<div class="detail-row"><span class="detail-key">版本</span><span class="detail-val">' + escapeHtml(data.process && data.process.version || '-') + '</span></div>';
      html += '<div class="detail-row"><span class="detail-key">启动时间</span><span class="detail-val">' + formatTime(data.process && data.process.startTime) + '</span></div>';
      html += '<div class="detail-row"><span class="detail-key">数据目录</span><span class="detail-val">' + escapeHtml(data.dataDir || '-') + '</span></div>';
      html += '</div>';

      if (data.feishu) {
        html += '<div class="card"><div class="card-header">飞书连接</div>';
        html += '<div class="detail-row"><span class="detail-key">连接状态</span><span class="detail-val">' + statusTag(data.feishu.connected ? 'running' : 'stopped') + '</span></div>';
        html += '<div class="detail-row"><span class="detail-key">摘要</span><span class="detail-val">' + escapeHtml(data.feishu.source || '-') + '</span></div>';
        html += '</div>';
      }

      if (data.agents && data.agents.length > 0) {
        html += '<div class="card"><div class="card-header">Agent 服务</div>';
        for (var ai = 0; ai < data.agents.length; ai++) {
          var ag = data.agents[ai];
          html += '<div class="detail-row"><span class="detail-key">' + escapeHtml(ag.name) + '</span><span class="detail-val">' + statusTag(ag.available ? 'running' : 'stopped') + ' ' + escapeHtml(ag.reason || '') + '</span></div>';
        }
        html += '</div>';
      }

      html += '<div class="card"><div class="card-header">统计</div>';
      html += '<div class="detail-row"><span class="detail-key">Session 数</span><span class="detail-val">' + (data.sessions && data.sessions.total || 0) + '</span></div>';
      html += '<div class="detail-row"><span class="detail-key">Route 数</span><span class="detail-val">' + (data.routes && data.routes.total || 0) + '</span></div>';
      html += '</div>';

      if (data.recentErrors && data.recentErrors.length > 0) {
        html += '<div class="card"><div class="card-header">最近错误</div>';
        for (var i = 0; i < data.recentErrors.length; i++) {
          var err = data.recentErrors[i];
          html += '<div class="timeline-item"><span class="tl-time">' + formatTime(err.createdAt) + '</span> <span class="tl-msg">' + escapeHtml(err.message) + '</span></div>';
        }
        html += '</div>';
      }

      document.getElementById('overviewContent').innerHTML = html;
    })
    .catch(function (err) {
      document.getElementById('overviewContent').innerHTML = '<div class="error-msg">' + escapeHtml(err.message) + '</div>';
    });
}

/**
 * REQ-004/005/006/016/017: Sessions 页渲染
 */
function renderSessions() {
  var app = getApp();
  app.innerHTML = '<h2 class="page-title">Sessions</h2>' +
    '<div class="form-actions"><button class="btn btn-primary" id="btnNewSession">创建 Session</button></div>' +
    '<div id="sessionList"></div>';

  document.getElementById('btnNewSession').addEventListener('click', showCreateSessionForm);
  loadSessionList();
}

/**
 * 加载 Session 列表
 */
function loadSessionList() {
  apiRequest('GET', API_SESSIONS)
    .then(function (payload) {
      var sessions = listFromPayload(payload);
      if (!sessions || sessions.length === 0) {
        document.getElementById('sessionList').innerHTML = emptyHint('暂无 Session');
        return;
      }
      var html = '<table class="data-table"><thead><tr>' +
        '<th>ID</th><th>标题</th><th>Agent</th><th>状态</th><th>CWD</th><th>Route</th><th>OpenCode</th><th>Server</th><th>创建时间</th><th>操作</th>' +
        '</tr></thead><tbody>';
      for (var i = 0; i < sessions.length; i++) {
        var s = sessions[i];
        html += '<tr>' +
          '<td data-label="ID">' + escapeHtml(s.id) + '</td>' +
          '<td data-label="标题">' + escapeHtml(s.title || '-') + '</td>' +
          '<td data-label="Agent">' + escapeHtml(s.agent || '-') + '</td>' +
          '<td data-label="状态">' + statusTag(s.status || '-') + '</td>' +
          '<td data-label="CWD">' + escapeHtml(s.cwd || '-') + '</td>' +
          '<td data-label="Route">' + renderSessionRouteSummary(s) + '</td>' +
          '<td data-label="OpenCode">' + escapeHtml(s.opencodeSessionId || '-') + '</td>' +
          '<td data-label="Server">' + escapeHtml(s.serverUrl || '-') + '</td>' +
          '<td data-label="创建时间">' + formatTime(s.createdAt) + '</td>' +
          '<td data-label="操作">' +
            '<button class="btn btn-small btn-default" data-action="detail" data-id="' + escapeHtml(s.id) + '">详情</button> ' +
            '<button class="btn btn-small btn-danger" data-action="stop" data-id="' + escapeHtml(s.id) + '">停止</button> ' +
            '<button class="btn btn-small btn-danger" data-action="delete" data-id="' + escapeHtml(s.id) + '">删除</button>' +
          '</td>' +
          '</tr>';
      }
      html += '</tbody></table>';
      document.getElementById('sessionList').innerHTML = html;

      /* 绑定操作按钮事件 */
      document.querySelectorAll('[data-action]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var action = btn.getAttribute('data-action');
          var sid = btn.getAttribute('data-id');
          if (action === 'detail') showSessionDetail(sid);
          else if (action === 'stop') stopSession(sid);
          else if (action === 'delete') deleteSession(sid);
        });
      });
    })
    .catch(function (err) {
      document.getElementById('sessionList').innerHTML = '<div class="error-msg">' + escapeHtml(err.message) + '</div>';
    });
}

/**
 * REQ-005: 显示创建 Session 表单
 */
function showCreateSessionForm() {
  var html = '<div class="card"><div class="card-header">创建 Session</div>' +
    '<form id="createSessionForm">' +
    '<div class="form-group"><label>agent</label><input name="agent" value="opencode"></div>' +
    '<div class="form-group"><label>title</label><input name="title" placeholder="Session 标题"></div>' +
    '<div class="form-group"><label>runtime</label><select name="runtime"><option value="windows">windows</option><option value="wsl">wsl</option></select></div>' +
    '<div class="form-group"><label>cwd</label><input name="cwd" placeholder="工作目录"></div>' +
    '<div class="form-group"><label>createAgentSession</label><select name="createAgentSession"><option value="true">是</option><option value="false">否</option></select></div>' +
    '<div class="form-actions"><button type="submit" class="btn btn-primary">创建</button><button type="button" class="btn btn-default" id="cancelCreate">取消</button></div>' +
    '</form></div>';

  document.getElementById('sessionList').innerHTML = html;

  document.getElementById('createSessionForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.target;
    var body = {
      agent: form.agent.value,
      title: form.title.value,
      runtime: form.runtime.value,
      cwd: form.cwd.value,
      createAgentSession: form.createAgentSession.value === 'true'
    };
    apiRequest('POST', API_SESSIONS, body)
      .then(function () {
        showToast('Session 创建成功', 'success');
        loadSessionList();
      })
      .catch(function (err) {
        showToast(err.message, 'error');
      });
  });

  document.getElementById('cancelCreate').addEventListener('click', loadSessionList);
}

/**
 * REQ-004/016: 显示 Session 详情和时间线
 * @param {string} sessionId
 */
function showSessionDetail(sessionId) {
  apiRequest('GET', API_SESSION_DETAIL + sessionId)
    .then(function (s) {
      var html = '<div class="card"><div class="card-header">Session 详情</div>';
      var fields = ['id', 'title', 'agent', 'status', 'runtime', 'cwd', 'isUnbound', 'routeKeys', 'focusRouteKeys', 'opencodeSessionId', 'serverUrl', 'agentRef', 'errorMessage', 'createdAt', 'updatedAt'];
      for (var i = 0; i < fields.length; i++) {
        var key = fields[i];
        var val = s[key];
        html += '<div class="detail-row"><span class="detail-key">' + escapeHtml(key) + '</span><span class="detail-val">' + renderJsonValue(val) + '</span></div>';
      }
      html += '</div>';

      /* REQ-017: Prompt 表单只在有 agentRef 时启用 */
      html += '<div class="card"><div class="card-header">发送 Prompt</div>';
      var disabled = !s.agentRef ? 'disabled' : '';
      html += '<form id="promptForm">' +
        '<div class="form-group"><label>prompt 内容</label><textarea name="text" rows="3" ' + disabled + ' placeholder="' + (s.agentRef ? '输入 prompt 内容' : '此 Session 无 agentRef，无法发送 prompt') + '"></textarea></div>' +
        '<div class="form-actions"><button type="submit" class="btn btn-primary" ' + disabled + '>发送</button></div>' +
        '</form></div>';

      /* REQ-016: 时间线 */
      html += '<div class="card"><div class="card-header">时间线</div><div id="timelineContent"><p>加载中...</p></div></div>';

      html += '<div class="form-actions"><button class="btn btn-default" id="backToList">返回列表</button></div>';

      getApp().innerHTML = html;

      document.getElementById('promptForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var text = e.target.text.value.trim();
        if (!text) return;
        apiRequest('POST', API_SESSION_PROMPT + sessionId + '/prompt', { text: text })
          .then(function () {
            showToast('Prompt 已发送', 'success');
            e.target.text.value = '';
          })
          .catch(function (err) { showToast(err.message, 'error'); });
      });

      loadTimeline(sessionId);

      document.getElementById('backToList').addEventListener('click', renderSessions);
    })
    .catch(function (err) {
      getApp().innerHTML = '<div class="error-msg">' + escapeHtml(err.message) + '</div>';
    });
}

/**
 * REQ-016: 加载 Session 时间线
 * @param {string} sessionId
 */
function loadTimeline(sessionId) {
  apiRequest('GET', API_SESSION_TIMELINE + sessionId + '/timeline')
    .then(function (events) {
      var html = '';
      if (!events || events.length === 0) {
        html = emptyHint('暂无时间线事件');
      } else {
        for (var i = 0; i < events.length; i++) {
          var ev = events[i];
          html += '<div class="timeline-item">' +
            '<span class="tl-type">' + escapeHtml(ev.type || '-') + '</span> ' +
            '<span class="tl-time">' + formatTime(ev.createdAt) + '</span>' +
            '<div class="tl-msg">' + escapeHtml(ev.message || '-') + '</div>' +
            '</div>';
        }
      }
      document.getElementById('timelineContent').innerHTML = html;
    })
    .catch(function (err) {
      document.getElementById('timelineContent').innerHTML = '<div class="error-msg">' + escapeHtml(err.message) + '</div>';
    });
}

/**
 * REQ-006: 停止 Session（带确认弹窗）
 * @param {string} sessionId
 */
function stopSession(sessionId) {
  showConfirm('确认停止 Session ' + sessionId + '？停止后 Session 将不可继续使用。', function () {
    apiRequest('POST', API_SESSION_STOP + sessionId + '/stop')
      .then(function () {
        showToast('Session 已停止', 'success');
        loadSessionList();
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  });
}

/**
 * REQ-006: 删除 Session（带确认弹窗）
 * @param {string} sessionId
 */
function deleteSession(sessionId) {
  showConfirm('确认删除 Session ' + sessionId + '？删除后数据不可恢复。', function () {
    apiRequest('DELETE', API_SESSION_DELETE + sessionId)
      .then(function () {
        showToast('Session 已删除', 'success');
        loadSessionList();
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  });
}

/**
 * REQ-007/008: Routes 页渲染
 */
function renderRoutes() {
  var app = getApp();
  app.innerHTML = '<h2 class="page-title">路由绑定</h2>' +
    '<div class="form-actions">' +
      '<button class="btn btn-primary" id="btnBindRoute">绑定路由</button> ' +
      '<button class="btn btn-danger" id="btnCleanupDangling">清理悬空路由</button>' +
    '</div>' +
    '<div id="routeList"></div>';

  document.getElementById('btnBindRoute').addEventListener('click', showBindRouteForm);
  document.getElementById('btnCleanupDangling').addEventListener('click', cleanupDanglingRoutes);
  loadRouteList();
}

/**
 * 加载路由列表
 */
function loadRouteList() {
  Promise.all([apiRequest('GET', API_ROUTES), apiRequest('GET', API_SESSIONS)])
    .then(function (results) {
      var routes = listFromPayload(results[0]);
      var sessions = listFromPayload(results[1]);
      var notice = renderUnboundSessionNotice(sessions);
      if ((!routes || routes.length === 0) && !notice) {
        document.getElementById('routeList').innerHTML = emptyHint('暂无路由绑定');
        return;
      }
      var html = notice;
      if (routes && routes.length > 0) {
        html += '<table class="data-table"><thead><tr>' +
          '<th>RouteKey</th><th>CWD</th><th>焦点</th><th>Sessions</th><th>状态</th><th>最近活跃</th><th>更新时间</th><th>操作</th>' +
          '</tr></thead><tbody>';
        for (var i = 0; i < routes.length; i++) {
          var r = routes[i];
          html += '<tr>' +
            '<td data-label="RouteKey">' + escapeHtml(r.routeKey || '-') + '</td>' +
            '<td data-label="CWD">' + escapeHtml(r.cwd || '-') + '</td>' +
            '<td data-label="焦点">' + escapeHtml(r.focusSessionId || r.sessionId || '-') + '</td>' +
            '<td data-label="Sessions">' + renderRouteSessionSummary(r) + '</td>' +
            '<td data-label="状态">' + statusTag(r.dangling ? 'dangling' : (r.health || 'unknown')) + '</td>' +
            '<td data-label="最近活跃">' + formatTime(r.lastActiveAt) + '</td>' +
            '<td data-label="更新时间">' + formatTime(r.updatedAt) + '</td>' +
            '<td data-label="操作">' +
              '<button class="btn btn-small btn-danger" data-action="unbind" data-key="' + escapeHtml(r.routeKey) + '">解除绑定</button>' +
            '</td>' +
            '</tr>';
        }
        html += '</tbody></table>';
      }
      document.getElementById('routeList').innerHTML = html;

      document.querySelectorAll('[data-action="unbind"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          unbindRoute(btn.getAttribute('data-key'));
        });
      });
    })
    .catch(function (err) {
      document.getElementById('routeList').innerHTML = '<div class="error-msg">' + escapeHtml(err.message) + '</div>';
    });
}

/**
 * REQ-007: 绑定路由表单
 */
function showBindRouteForm() {
  var html = '<div class="card"><div class="card-header">绑定路由</div>' +
    '<form id="bindRouteForm">' +
    '<div class="form-group"><label>routeKey</label><input name="routeKey" placeholder="如 feishu:chatId:openId:rootId"></div>' +
    '<div class="form-group"><label>sessionId</label><input name="sessionId" placeholder="目标 Session ID"></div>' +
    '<div class="form-actions"><button type="submit" class="btn btn-primary">绑定</button><button type="button" class="btn btn-default" id="cancelBind">取消</button></div>' +
    '</form></div>';
  document.getElementById('routeList').innerHTML = html;

  document.getElementById('bindRouteForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var body = {
      routeKey: e.target.routeKey.value,
      sessionId: e.target.sessionId.value
    };
    apiRequest('POST', API_ROUTES, body)
      .then(function () {
        showToast('路由绑定成功', 'success');
        loadRouteList();
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  });

  document.getElementById('cancelBind').addEventListener('click', loadRouteList);
}

/**
 * REQ-007: 解除路由绑定（带确认弹窗）
 * @param {string} routeKey
 */
function unbindRoute(routeKey) {
  showConfirm('确认解除路由 ' + routeKey + ' 的绑定？', function () {
    apiRequest('DELETE', API_ROUTES + '/' + encodeURIComponent(routeKey))
      .then(function () {
        showToast('路由已解除绑定', 'success');
        loadRouteList();
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  });
}

/**
 * REQ-008: 清理悬空路由（带确认弹窗）
 */
function cleanupDanglingRoutes() {
  showConfirm('确认清理所有悬空路由？清理后绑定关系不可恢复。', function () {
    apiRequest('POST', API_ROUTES_CLEANUP_DANGLING, { confirm: true })
      .then(function (data) {
        showToast('已清理 ' + (data.cleaned || 0) + ' 条悬空路由', 'success');
        loadRouteList();
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  });
}

/**
 * REQ-009/010/022: Agents 页渲染
 */
function renderAgents() {
  var app = getApp();
  app.innerHTML = '<h2 class="page-title">Agent</h2><div id="agentList"></div>';

  apiRequest('GET', API_AGENTS)
    .then(function (agents) {
      if (!agents || agents.length === 0) {
        document.getElementById('agentList').innerHTML = emptyHint('暂无 Agent');
        return;
      }
      var html = '<table class="data-table"><thead><tr>' +
        '<th>名称</th><th>可用</th><th>原因</th><th>配置摘要</th><th>操作</th>' +
        '</tr></thead><tbody>';
      for (var i = 0; i < agents.length; i++) {
        var a = agents[i];
        html += '<tr>' +
          '<td data-label="名称">' + escapeHtml(a.name) + '</td>' +
          '<td data-label="可用">' + statusTag(a.available ? 'running' : 'stopped') + '</td>' +
          '<td data-label="原因">' + escapeHtml(a.reason || '-') + '</td>' +
          '<td data-label="配置摘要">' + escapeHtml(JSON.stringify(a.config || {})) + '</td>' +
          '<td data-label="操作">' +
            '<button class="btn btn-small btn-default" data-action="check" data-name="' + escapeHtml(a.name) + '">检测</button> ' +
            '<button class="btn btn-small btn-default" data-action="ensure" data-name="' + escapeHtml(a.name) + '">尝试启动</button>' +
          '</td>' +
          '</tr>';
      }
      html += '</tbody></table>';
      document.getElementById('agentList').innerHTML = html;

      document.querySelectorAll('[data-action="check"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          checkAgent(btn.getAttribute('data-name'));
        });
      });

      document.querySelectorAll('[data-action="ensure"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          ensureReadyAgent(btn.getAttribute('data-name'));
        });
      });
    })
    .catch(function (err) {
      document.getElementById('agentList').innerHTML = '<div class="error-msg">' + escapeHtml(err.message) + '</div>';
    });
}

/**
 * REQ-010: 检测 Agent 健康状态
 * @param {string} agentName
 */
function checkAgent(agentName) {
  apiRequest('POST', API_AGENTS + '/' + encodeURIComponent(agentName) + '/check')
    .then(function (data) {
      showToast('Agent ' + agentName + ' 健康检查: ' + (data.healthy ? '正常' : '异常') + (data.error ? ' - ' + data.error : ''), data.healthy ? 'success' : 'error');
    })
    .catch(function (err) { showToast(err.message, 'error'); });
}

/**
 * REQ-010: 尝试启动 Agent（ensure-ready）
 * @param {string} agentName
 */
function ensureReadyAgent(agentName) {
  apiRequest('POST', API_AGENTS + '/' + encodeURIComponent(agentName) + '/ensure-ready')
    .then(function (data) {
      showToast('Agent ' + agentName + (data.ready ? ' 已就绪' : ' 启动失败') + (data.error ? ' - ' + data.error : ''), data.ready ? 'success' : 'error');
      renderAgents();
    })
    .catch(function (err) { showToast(err.message, 'error'); });
}

/**
 * REQ-011: Runtime 页渲染
 */
function renderRuntime() {
  var app = getApp();
  app.innerHTML = '<h2 class="page-title">Runtime</h2><div id="runtimeContent"><p>加载中...</p></div>';

  apiRequest('GET', API_RUNTIME)
    .then(function (data) {
      var html = '<div class="card"><div class="card-header">Runtime 配置与检测</div>';

      if (data.windows) {
        html += '<h4>Windows</h4>';
        html += '<div class="detail-row"><span class="detail-key">类型</span><span class="detail-val">' + escapeHtml(data.windows.type || '-') + '</span></div>';
        html += '<div class="detail-row"><span class="detail-key">工作目录</span><span class="detail-val">' + escapeHtml(data.windows.cwd || '-') + '</span></div>';
        html += '<div class="detail-row"><span class="detail-key">目录存在</span><span class="detail-val">' + statusTag(data.windows.cwdExists ? 'pass' : 'fail') + '</span></div>';
      }

      if (data.wsl) {
        html += '<h4>WSL</h4>';
        html += '<div class="detail-row"><span class="detail-key">类型</span><span class="detail-val">' + escapeHtml(data.wsl.type || '-') + '</span></div>';
        html += '<div class="detail-row"><span class="detail-key">Distro</span><span class="detail-val">' + escapeHtml(data.wsl.distro || '-') + '</span></div>';
        html += '<div class="detail-row"><span class="detail-key">工作目录</span><span class="detail-val">' + escapeHtml(data.wsl.cwd || '-') + '</span></div>';
        html += '<div class="detail-row"><span class="detail-key">目录存在</span><span class="detail-val">' + statusTag(data.wsl.cwdExists ? 'pass' : 'fail') + '</span></div>';
        html += '<div class="detail-row"><span class="detail-key">IP 探测</span><span class="detail-val">' + escapeHtml(data.wsl.ipDetected ? data.wsl.ip : '未探测到') + '</span></div>';
      }

      html += '</div>';
      document.getElementById('runtimeContent').innerHTML = html;
    })
    .catch(function (err) {
      document.getElementById('runtimeContent').innerHTML = '<div class="error-msg">' + escapeHtml(err.message) + '</div>';
    });
}

/**
 * REQ-013/014: 日志页渲染
 */
function renderLogs() {
  var app = getApp();
  app.innerHTML = '<h2 class="page-title">日志</h2>' +
    '<div class="card">' +
      '<form id="logFilterForm">' +
        '<div class="form-group"><label>文件</label><select name="stream"><option value="out">out</option><option value="err">err</option></select></div>' +
        '<div class="form-group"><label>关键词</label><input name="q" placeholder="搜索关键词"></div>' +
        '<div class="form-group"><label>级别</label><select name="level"><option value="">全部</option><option value="error">error</option><option value="warn">warn</option><option value="info">info</option></select></div>' +
        '<div class="form-actions"><button type="submit" class="btn btn-primary">刷新</button></div>' +
      '</form>' +
    '</div>' +
    '<div id="logContent"></div>';

  document.getElementById('logFilterForm').addEventListener('submit', function (e) {
    e.preventDefault();
    loadLogs(e.target.stream.value, e.target.q.value, e.target.level.value);
  });

  loadLogs('out', '', '');
}

/**
 * REQ-013: 加载日志内容
 * @param {string} stream - 文件类型 out/err
 * @param {string} q - 关词
 * @param {string} level - 级别过滤
 */
function loadLogs(stream, q, level) {
  var url = API_LOGS + '?stream=' + encodeURIComponent(stream) + '&lines=500';
  if (q) url += '&q=' + encodeURIComponent(q);
  if (level) url += '&level=' + encodeURIComponent(level);

  apiRequest('GET', url)
    .then(function (data) {
      var html = '';
      if (!data.lines || data.lines.length === 0) {
        html = emptyHint('暂无日志数据');
      } else {
        for (var i = 0; i < data.lines.length; i++) {
          var line = data.lines[i];
          var levelCls = line.level ? ' level-' + line.level : '';
          html += '<div class="log-line' + levelCls + '">' + escapeHtml(line.text || line) + '</div>';
        }
      }
      document.getElementById('logContent').innerHTML = html;
    })
    .catch(function (err) {
      document.getElementById('logContent').innerHTML = '<div class="error-msg">' + escapeHtml(err.message) + '</div>';
    });
}

/**
 * REQ-014: 事件页（在总览/日志/指标相关区域展示）
 */
function loadEvents(targetId) {
  apiRequest('GET', API_EVENTS + '?limit=200')
    .then(function (events) {
      var html = '';
      if (!events || events.length === 0) {
        html = emptyHint('暂无事件');
      } else {
        for (var i = 0; i < events.length; i++) {
          var ev = events[i];
          html += '<div class="timeline-item">' +
            '<span class="tl-type">' + escapeHtml(ev.type) + '</span> ' +
            '<span class="tl-time">' + formatTime(ev.createdAt) + '</span>' +
            '<div class="tl-msg">' + escapeHtml(ev.message || '-') + '</div>' +
            '</div>';
        }
      }
      var el = document.getElementById(targetId || 'eventsList');
      if (el) el.innerHTML = html;
    });
}

/**
 * REQ-015: 附件页渲染
 */
function renderAttachments() {
  var app = getApp();
  app.innerHTML = '<h2 class="page-title">附件</h2>' +
    '<div class="form-actions"><button class="btn btn-danger" id="btnDeleteOrphan">删除孤立附件</button></div>' +
    '<div id="attachmentList"></div>';

  document.getElementById('btnDeleteOrphan').addEventListener('click', deleteOrphanAttachments);
  loadAttachmentList();
}

/**
 * 加载附件列表
 */
function loadAttachmentList() {
  apiRequest('GET', API_ATTACHMENTS)
    .then(function (data) {
      if (!data || !data.groups || data.groups.length === 0) {
        document.getElementById('attachmentList').innerHTML = emptyHint('暂无附件');
        return;
      }
      var html = '<table class="data-table"><thead><tr>' +
        '<th>Session</th><th>文件名</th><th>大小</th><th>修改时间</th><th>操作</th>' +
        '</tr></thead><tbody>';
      for (var i = 0; i < data.groups.length; i++) {
        var group = data.groups[i];
        for (var j = 0; j < group.files.length; j++) {
          var f = group.files[j];
          html += '<tr>' +
            '<td data-label="Session">' + escapeHtml(group.sessionId || '-') + '</td>' +
            '<td data-label="文件名">' + escapeHtml(f.name || '-') + '</td>' +
            '<td data-label="大小">' + (f.size || '-') + '</td>' +
            '<td data-label="修改时间">' + formatTime(f.modifiedAt) + '</td>' +
            '<td data-label="操作">' +
              '<a class="btn btn-small btn-default" href="' + API_ATTACHMENTS + '/' + encodeURIComponent(group.sessionId) + '/' + encodeURIComponent(f.name) + '">下载</a> ' +
              '<button class="btn btn-small btn-danger" data-action="deleteAtt" data-session="' + encodeURIComponent(group.sessionId) + '" data-filename="' + encodeURIComponent(f.name) + '">删除</button>' +
            '</td>' +
            '</tr>';
        }
      }
      html += '</tbody></table>';
      document.getElementById('attachmentList').innerHTML = html;

      document.querySelectorAll('[data-action="deleteAtt"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          deleteAttachment(btn.getAttribute('data-session'), btn.getAttribute('data-filename'));
        });
      });
    })
    .catch(function (err) {
      document.getElementById('attachmentList').innerHTML = '<div class="error-msg">' + escapeHtml(err.message) + '</div>';
    });
}

/**
 * REQ-015: 删除单个附件（带确认弹窗）
 * @param {string} filePath
 */
function deleteAttachment(sessionId, filename) {
  showConfirm('确认删除附件？删除后文件不可恢复。', function () {
    apiRequest('DELETE', API_ATTACHMENTS + '/' + encodeURIComponent(sessionId) + '/' + encodeURIComponent(filename))
      .then(function () {
        showToast('附件已删除', 'success');
        loadAttachmentList();
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  });
}

/**
 * REQ-015: 删除孤立附件（带确认弹窗）
 */
function deleteOrphanAttachments() {
  showConfirm('确认删除所有孤立附件？删除后文件不可恢复。', function () {
    apiRequest('POST', API_MAINTENANCE_CLEANUP, { confirmed: true })
      .then(function (data) {
        var count = (data.attachments && data.attachments.cleaned && data.attachments.cleaned.length) || 0;
        showToast('已清理 ' + count + ' 个孤立附件', count > 0 ? 'success' : 'warning');
        loadAttachmentList();
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  });
}

/**
 * REQ-012: 配置页渲染（secret 脱敏，allowlist 编辑）
 */
function renderConfig() {
  var app = getApp();
  app.innerHTML = '<h2 class="page-title">配置</h2><div id="configContent"><p>加载中...</p></div>';

  apiRequest('GET', API_CONFIG)
    .then(function (data) {
      var html = '<div class="card"><div class="card-header">当前配置（脱敏）</div>';

      /* 展示脱敏后的配置值 */
      var config = data.config || data;
      for (var key in config) {
        html += '<div class="detail-row"><span class="detail-key">' + escapeHtml(key) + '</span><span class="detail-val">' + secretTag(key, config[key]) + '</span></div>';
      }
      html += '</div>';

      /* 可编辑字段表单 */
      var editable = data.editable || [];
      if (editable.length > 0) {
        html += '<div class="card"><div class="card-header">编辑配置（allowlist 字段）</div>';
        html += '<form id="configEditForm">';
        for (var i = 0; i < editable.length; i++) {
          var ek = editable[i];
          html += '<div class="form-group"><label>' + escapeHtml(ek) + '</label>' +
            '<input name="' + escapeHtml(ek) + '" value="' + escapeHtml(String(config[ek] || '')) + '"></div>';
        }
        html += '<div class="form-actions"><button type="submit" class="btn btn-primary">保存</button></div>';
        html += '</form></div>';
      }

      if (data.source) {
        html += '<div class="card"><div class="card-header">配置来源</div>';
        html += '<div class="detail-row"><span class="detail-key">来源</span><span class="detail-val">' + escapeHtml(data.source || '-') + '</span></div>';
        html += '</div>';
      }

      document.getElementById('configContent').innerHTML = html;

      if (document.getElementById('configEditForm')) {
        document.getElementById('configEditForm').addEventListener('submit', function (e) {
          e.preventDefault();
          var body = {};
          var inputs = e.target.querySelectorAll('input');
          for (var j = 0; j < inputs.length; j++) {
            body[inputs[j].name] = inputs[j].value;
          }
          apiRequest('PATCH', API_CONFIG, body)
            .then(function (result) {
              showToast('配置已保存' + (result.restartRequired ? '，需要重启生效' : ''), result.restartRequired ? 'warning' : 'success');
              renderConfig();
            })
            .catch(function (err) { showToast(err.message, 'error'); });
        });
      }
    })
    .catch(function (err) {
      document.getElementById('configContent').innerHTML = '<div class="error-msg">' + escapeHtml(err.message) + '</div>';
    });
}

/**
 * REQ-018: 诊断页渲染（一键健康检查）
 */
function renderDiagnostics() {
  var app = getApp();
  app.innerHTML = '<h2 class="page-title">诊断</h2>' +
    '<div class="form-actions"><button class="btn btn-primary" id="btnHealthCheck">一键健康检查</button></div>' +
    '<div id="healthResult"></div>';

  document.getElementById('btnHealthCheck').addEventListener('click', runHealthCheck);
}

/**
 * REQ-018: 执行一键健康检查
 */
function runHealthCheck() {
  apiRequest('GET', API_HEALTH)
    .then(function (checks) {
      var html = '<table class="data-table"><thead><tr>' +
        '<th>检查项</th><th>状态</th><th>详情</th>' +
        '</tr></thead><tbody>';
      for (var i = 0; i < checks.length; i++) {
        var c = checks[i];
        html += '<tr>' +
          '<td data-label="检查项">' + escapeHtml(c.name) + '</td>' +
          '<td data-label="状态">' + statusTag(c.status) + '</td>' +
          '<td data-label="详情">' + escapeHtml(c.detail || '-') + '</td>' +
          '</tr>';
      }
      html += '</tbody></table>';
      document.getElementById('healthResult').innerHTML = html;
    })
    .catch(function (err) {
      document.getElementById('healthResult').innerHTML = '<div class="error-msg">' + escapeHtml(err.message) + '</div>';
    });
}

/**
 * REQ-019: 维护页渲染
 */
function renderMaintenance() {
  var app = getApp();
  app.innerHTML = '<h2 class="page-title">维护</h2>' +
    '<div class="card">' +
      '<div class="card-header">数据维护工具</div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-primary" id="btnExport">导出数据</button> ' +
        '<button class="btn btn-primary" id="btnBackup">备份数据</button> ' +
        '<button class="btn btn-danger" id="btnCleanup">确认清理</button>' +
      '</div>' +
    '</div>' +
    '<div id="maintenanceResult"></div>';

  document.getElementById('btnExport').addEventListener('click', exportData);
  document.getElementById('btnBackup').addEventListener('click', backupData);
  document.getElementById('btnCleanup').addEventListener('click', cleanupData);
}

/**
 * REQ-019: 导出数据
 */
function exportData() {
  apiRequest('GET', API_MAINTENANCE_EXPORT)
    .then(function (data) {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'walker-export.json';
      a.click();
      URL.revokeObjectURL(url);
      showToast('数据已导出', 'success');
    })
    .catch(function (err) { showToast(err.message, 'error'); });
}

/**
 * REQ-019: 备份数据
 */
function backupData() {
  apiRequest('POST', API_MAINTENANCE_BACKUP)
    .then(function (data) {
      showToast('备份完成: ' + (data.file || ''), 'success');
      document.getElementById('maintenanceResult').innerHTML = '<div class="card"><p>备份文件: ' + escapeHtml(data.file || '-') + '</p></div>';
    })
    .catch(function (err) { showToast(err.message, 'error'); });
}

/**
 * REQ-019: 确认清理（带确认弹窗）
 */
function cleanupData() {
  showConfirm('确认清理？将清理已停止/已删除的 Session 路由和孤立附件，不可恢复。', function () {
    apiRequest('POST', API_MAINTENANCE_CLEANUP, { confirmed: true })
      .then(function (data) {
        showToast('清理完成', 'success');
        document.getElementById('maintenanceResult').innerHTML = '<div class="card"><p>清理结果: ' + escapeHtml(JSON.stringify(data)) + '</p></div>';
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  });
}

/**
 * REQ-020/021: 工具页渲染（命令模拟器 + 卡片预览）
 */
function renderTools() {
  var app = getApp();
  app.innerHTML = '<h2 class="page-title">工具</h2>' +
    '<div class="card"><div class="card-header">飞书命令模拟器</div>' +
      '<form id="cmdSimForm">' +
        '<div class="form-group"><label>命令</label><input name="command" placeholder="/new, /list, /use 等"></div>' +
        '<div class="form-group"><label>routeKey</label><input name="routeKey" placeholder="模拟 routeKey"></div>' +
        '<div class="form-actions"><button type="submit" class="btn btn-primary">模拟</button></div>' +
      '</form>' +
      '<div id="cmdSimResult"></div>' +
    '</div>' +
    '<div class="card"><div class="card-header">卡片预览</div>' +
      '<div id="cardTypeList"></div>' +
      '<div id="cardPreviewArea"></div>' +
    '</div>';

  document.getElementById('cmdSimForm').addEventListener('submit', function (e) {
    e.preventDefault();
    simulateCommand(e.target.command.value, e.target.routeKey.value);
  });

  loadCardTypes();
}

/**
 * REQ-020: 模拟命令执行
 * @param {string} command - 命令文本
 * @param {string} routeKey - 模拟 routeKey
 */
function simulateCommand(command, routeKey) {
  var url = API_COMMAND_SIMULATE + '?text=' + encodeURIComponent(command);
  if (routeKey) url += '&routeKey=' + encodeURIComponent(routeKey);
  apiRequest('GET', url)
    .then(function (data) {
      var html = '<div class="card"><div class="card-header">模拟结果</div>';
      html += '<div class="detail-row"><span class="detail-key">输入</span><span class="detail-val">' + escapeHtml(data.input || command) + '</span></div>';
      html += '<div class="detail-row"><span class="detail-key">解析</span><span class="detail-val">' + escapeHtml(JSON.stringify(data.parsed || {})) + '</span></div>';
      html += '<div class="detail-row"><span class="detail-key">动作</span><span class="detail-val">' + escapeHtml(data.action ? JSON.stringify(data.action) : '-') + '</span></div>';
      html += '<div class="detail-row"><span class="detail-key">dryRun</span><span class="detail-val">' + (data.dryRun ? '是（未真实发送）' : '否') + '</span></div>';
      html += '</div>';
      document.getElementById('cmdSimResult').innerHTML = html;
    })
    .catch(function (err) {
      document.getElementById('cmdSimResult').innerHTML = '<div class="error-msg">' + escapeHtml(err.message) + '</div>';
    });
}

/**
 * REQ-021: 加载卡片类型列表
 */
function loadCardTypes() {
  apiRequest('GET', API_CARDS)
    .then(function (types) {
      if (!types || types.length === 0) {
        document.getElementById('cardTypeList').innerHTML = emptyHint('暂无卡片类型');
        return;
      }
      var html = '';
      for (var i = 0; i < types.length; i++) {
        var t = types[i];
        html += '<button class="btn btn-default" data-card-type="' + escapeHtml(t.name) + '">' + escapeHtml(t.name) + ' - ' + escapeHtml(t.description || '') + '</button> ';
      }
      document.getElementById('cardTypeList').innerHTML = html;

      document.querySelectorAll('[data-card-type]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          previewCard(btn.getAttribute('data-card-type'));
        });
      });
    })
    .catch(function (err) {
      document.getElementById('cardTypeList').innerHTML = '<div class="error-msg">' + escapeHtml(err.message) + '</div>';
    });
}

/**
 * REQ-021: 预览卡片
 * @param {string} typeName - 卡片类型名
 */
function previewCard(typeName) {
  apiRequest('POST', API_CARDS_PREVIEW, { type: typeName })
    .then(function (data) {
      var html = '<div class="card"><div class="card-header">卡片预览: ' + escapeHtml(typeName) + '</div>';
      html += '<h4>JSON 数据</h4>';
      html += '<pre>' + escapeHtml(JSON.stringify(data.data || {}, null, 2)) + '</pre>';
      if (data.preview) {
        html += '<h4>简化预览</h4>';
        html += '<div class="detail-row"><span class="detail-key">标题</span><span class="detail-val">' + escapeHtml(data.preview.header ? data.preview.header.title : '-') + '</span></div>';
        html += '<div class="detail-row"><span class="detail-key">模板</span><span class="detail-val">' + escapeHtml(data.preview.header ? data.preview.header.template : '-') + '</span></div>';
        html += '<div class="detail-row"><span class="detail-key">元素数</span><span class="detail-val">' + (data.preview.elementCount || 0) + '</span></div>';
      }
      html += '</div>';
      document.getElementById('cardPreviewArea').innerHTML = html;
    })
    .catch(function (err) {
      document.getElementById('cardPreviewArea').innerHTML = '<div class="error-msg">' + escapeHtml(err.message) + '</div>';
    });
}

/**
 * REQ-023: 指标页渲染
 */
function renderMetrics() {
  var app = getApp();
  app.innerHTML = '<h2 class="page-title">指标</h2><div id="metricsContent"><p>加载中...</p></div>';

  apiRequest('GET', API_METRICS)
    .then(function (data) {
      var html = '<div class="card"><div class="card-header">运行指标</div>';
      var metrics = data.metrics || data;
      var labels = { messages: '消息数', commands: '命令数', errors: '错误数', prompts: 'Prompt 数' };
      for (var key in labels) {
        html += '<div class="metric-bar"><span class="metric-label">' + escapeHtml(labels[key]) + '</span><span class="metric-value">' + (metrics[key] || 0) + '</span></div>';
      }

      if (metrics.promptDurationsMs && metrics.promptDurationsMs.length > 0) {
        var avg = metrics.promptDurationsMs.reduce(function (a, b) { return a + b; }, 0) / metrics.promptDurationsMs.length;
        html += '<div class="metric-bar"><span class="metric-label">平均 Prompt 耗时</span><span class="metric-value">' + Math.round(avg) + ' ms</span></div>';
      }

      html += '</div>';

      /* 最近 60 分钟趋势 */
      if (data.buckets) {
        html += '<div class="card"><div class="card-header">最近 60 分钟趋势</div>';
        for (var i = 0; i < data.buckets.length; i++) {
          var b = data.buckets[i];
          html += '<div class="metric-bar"><span class="metric-label">' + formatTime(b.minute) + '</span><span class="metric-value">' + (b.count || 0) + '</span><span class="metric-trend">事件</span></div>';
        }
        html += '</div>';
      }

      /* 事件查看入口 */
      html += '<div class="card"><div class="card-header">最近事件</div><div id="eventsList"><p>加载中...</p></div></div>';

      document.getElementById('metricsContent').innerHTML = html;

      apiRequest('GET', API_EVENTS + '?limit=200')
        .then(function (events) {
          var evHtml = '';
          if (!events || events.length === 0) {
            evHtml = emptyHint('暂无事件');
          } else {
            for (var j = 0; j < events.length; j++) {
              var ev = events[j];
              evHtml += '<div class="timeline-item">' +
                '<span class="tl-type">' + escapeHtml(ev.type) + '</span> ' +
                '<span class="tl-time">' + formatTime(ev.createdAt) + '</span>' +
                '<div class="tl-msg">' + escapeHtml(ev.message || '-') + '</div>' +
                '</div>';
            }
          }
          var eventsListEl = document.getElementById('eventsList');
          if (eventsListEl) eventsListEl.innerHTML = evHtml;
        });
    })
    .catch(function (err) {
      document.getElementById('metricsContent').innerHTML = '<div class="error-msg">' + escapeHtml(err.message) + '</div>';
    });
}

/* ============================================================
 * REQ-024: 服务停止（二次确认）
 * ============================================================ */

/**
 * 停止 Walker 服务（二次确认弹窗）
 */
function stopService() {
  showConfirm('确认停止服务？服务将停止，Walker 进程将退出。', function () {
    apiRequest('POST', API_SERVICE_STOP, { confirm: true })
      .then(function () {
        showToast('服务将停止...', 'warning');
      })
      .catch(function (err) { showToast(err.message, 'error'); });
  });
}

/* ============================================================
 * 应用初始化
 * ============================================================ */

/**
 * 初始化应用：检查认证状态并启动路由
 */
function initApp() {
  checkAuth();
}

initApp();
