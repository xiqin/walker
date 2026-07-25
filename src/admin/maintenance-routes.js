'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { success, error, send, parseQueryString } = require('./response');
const { parseBody } = require('./auth');
const { recordEvent } = require('./event-store');

const fileAdmin = require('./file-admin');
const diagnostics = require('./diagnostics');
const routeAdmin = require('./route-admin');

function sanitizeHeaderFilename(name) {
  if (!name || typeof name !== 'string') return 'download';
  const safe = name.replace(/[\r\n"]/g, '_');
  return safe || 'download';
}

const MIME_TYPES = {
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.md': 'text/markdown',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
};

function getMimeType(filename) {
  if (!filename || typeof filename !== 'string') return 'application/octet-stream';
  const ext = path.extname(filename).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * 创建维护管理路由列表
 * 覆盖日志读取、附件操作、数据导出、备份、清理和健康检查
 * @param {Object} appContext - 应用上下文
 * @param {string} [appContext.dataDir] - 数据目录绝对路径
 * @param {Object} [appContext.sessionService] - Session 服务实例
 * @param {Object} [appContext.eventStore] - 事件存储实例
 * @param {Object} [appContext.envConfig] - 环境配置
 * @param {Object} [appContext.registry] - Driver 注册表
 * @param {Object} [appContext.routeAdmin] - Route 管理模块
 * @returns {Array<{ method: string, pattern: string, handler: Function }>} 路由数组
 */
function createMaintenanceRoutes(appContext) {
  const ctx = appContext || {};
  const routes = [];

  /**
   * GET /api/admin/logs
   * 读取日志，支持 stream/lines/keyword/level 查询参数
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/logs',
    handler: function logsHandler(req, res) {
      const qs = req.queryString || '';
      const params = parseQueryString(qs);
      const result = fileAdmin.readLogs({
        dataDir: ctx.dataDir || '',
        stream: params.stream || 'out',
        lines: params.lines ? parseInt(params.lines, 10) : 500,
        keyword: params.keyword || '',
        level: params.level || '',
      });
      send(res, success(result));
    },
  });

  /**
   * GET /api/admin/attachments
   * 列出所有附件，按 session 分组，支持分页
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/attachments',
    handler: function attachmentsListHandler(req, res) {
      const qs = req.queryString || '';
      const params = parseQueryString(qs);
      const result = fileAdmin.listAttachments(ctx.dataDir || '', {
        limit: params.limit ? parseInt(params.limit, 10) : 50,
        offset: params.offset ? parseInt(params.offset, 10) : 0,
      });
      send(res, success(result));
    },
  });

  /**
   * GET /api/admin/attachments/:sessionId/:filename
   * 下载指定附件文件
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/attachments/:sessionId/:filename',
    handler: function attachmentDownloadHandler(_req, res, params) {
      const result = fileAdmin.getAttachment(
        ctx.dataDir || '',
        params.sessionId,
        params.filename,
      );

      if (!result.ok) {
        send(res, error('NOT_FOUND', result.error), 404);
        return;
      }

      res.writeHead(200, {
        'Content-Type': getMimeType(params.filename),
        'Content-Disposition': `attachment; filename="${sanitizeHeaderFilename(params.filename)}"`,
        'Content-Length': result.data.length,
      });
      res.end(result.data);
    },
  });

  /**
   * DELETE /api/admin/attachments/:sessionId/:filename
   * 删除指定附件文件，严格验证路径安全
   */
  routes.push({
    method: 'DELETE',
    pattern: '/api/admin/attachments/:sessionId/:filename',
    handler: function attachmentDeleteHandler(_req, res, params) {
      const result = fileAdmin.deleteAttachment(
        ctx.dataDir || '',
        params.sessionId,
        params.filename,
      );

      if (!result.ok) {
        const code = result.error.includes('路径穿越') ? 'BAD_REQUEST' : 'NOT_FOUND';
        const status = code === 'BAD_REQUEST' ? 400 : 404;
        send(res, error(code, result.error), status);
        return;
      }

      recordEvent(ctx.eventStore, {
        type: 'attachment.delete',
        message: '附件已删除',
        data: { sessionId: params.sessionId, filename: params.filename },
      });

      send(res, success({ deleted: true }));
    },
  });

  /**
   * GET /api/admin/export
   * 导出 sessions 和 routes 数据为 JSON，支持 gzip 压缩
   * 查询参数 compress=true 启用 gzip 压缩
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/export',
    handler: function exportHandler(req, res) {
      const sessionService = ctx.sessionService;
      if (!sessionService) {
        send(res, error('NOT_FOUND', 'session 服务未提供'), 404);
        return;
      }

      const state = sessionService.stateStore.read();
      const sessionsData = state.sessions || {};
      const routesData = state.routes || {};

      const exportData = {
        sessions: sessionsData,
        routes: routesData,
        exportedAt: new Date().toISOString(),
      };

      recordEvent(ctx.eventStore, {
        type: 'maintenance.export',
        message: '数据已导出',
      });

      const qs = req.queryString || '';
      const params = parseQueryString(qs);
      const compress = params.compress === 'true' || params.compress === '1';

      if (compress) {
        const jsonStr = JSON.stringify(exportData, null, 2);
        zlib.gzip(jsonStr, (err, compressed) => {
          if (err) {
            send(res, error('INTERNAL_ERROR', '压缩失败'), 500);
            return;
          }

          res.writeHead(200, {
            'Content-Type': 'application/gzip',
            'Content-Disposition': 'attachment; filename="walker-export.json.gz"',
            'Content-Length': compressed.length,
          });
          res.end(compressed);
        });
      } else {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="walker-export.json"',
        });
        res.end(JSON.stringify(exportData, null, 2));
      }
    },
  });

  /**
   * POST /api/admin/backup
   * 备份 sessions 和 routes 数据到带时间戳的副本文件
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/backup',
    handler: function backupHandler(_req, res) {
      const dataDir = ctx.dataDir || '';
      const sessionService = ctx.sessionService;

      if (!dataDir || !sessionService) {
        send(res, error('BAD_REQUEST', '数据目录或 session 服务未提供'), 400);
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

      const files = [
        { name: 'state.json', store: sessionService.stateStore },
      ];

      const backedUp = [];

      for (const file of files) {
        const srcPath = path.join(dataDir, file.name);
        const destPath = path.join(dataDir, `${file.name}.backup-${timestamp}`);

        try {
          if (fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, destPath);
            backedUp.push({ file: file.name, backup: destPath });
          } else {
            const data = file.store.read();
            fs.writeFileSync(destPath, JSON.stringify(data, null, 2), 'utf8');
            backedUp.push({ file: file.name, backup: destPath });
          }
        } catch (err) {
          backedUp.push({ file: file.name, error: err.message });
        }
      }

      recordEvent(ctx.eventStore, {
        type: 'maintenance.backup',
        message: '数据已备份',
        data: { timestamp, files: backedUp },
      });

      send(res, success({ timestamp, files: backedUp }));
    },
  });

  /**
   * POST /api/admin/cleanup
   * 确认后清理 stopped/deleted session 的 route 绑定和孤立附件
   * 需要请求体含 confirm=true 才执行清理
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/cleanup',
    handler: async function cleanupHandler(req, res) {
      const sessionService = ctx.sessionService;
      if (!sessionService) {
        send(res, error('BAD_REQUEST', 'session 服务未提供'), 400);
        return;
      }

      let body;
      try {
        body = await parseBody(req);
      } catch (err) {
        if (err.code === 'PAYLOAD_TOO_LARGE') {
          send(res, error('PAYLOAD_TOO_LARGE', err.message), 413);
          return;
        }
        send(res, error('BAD_REQUEST', '无效请求体'), 400);
        return;
      }
      if (!body || body.confirmed !== true) {
        send(res, error('BAD_REQUEST', '清理操作需要 confirmed=true 确认'), 400);
        return;
      }

      const results = {};

      const danglingResult = routeAdmin.cleanupDangling(ctx, true);
      results.routes = danglingResult;

      const state = sessionService.stateStore.read();
      const sessionsData = state.sessions || {};
      const orphanResult = fileAdmin.cleanupOrphanAttachments(
        ctx.dataDir || '',
        sessionsData,
        true,
      );
      results.attachments = orphanResult;

      recordEvent(ctx.eventStore, {
        type: 'maintenance.cleanup',
        message: '确认清理已执行',
        data: results,
      });

      send(res, success(results));
    },
  });

  /**
   * GET /api/admin/health
   * 一键健康检查，返回 pass/warn/fail 项目数组
   * 单项失败不导致整体 500
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/health',
    handler: async function healthHandler(_req, res) {
      try {
        const checks = await diagnostics.runHealthCheck(ctx);
        const allPass = checks.every((c) => c.status === 'pass');
        send(res, success({
          overall: allPass ? 'pass' : 'degraded',
          checks,
        }));
      } catch (err) {
        send(res, success({
          overall: 'fail',
          checks: [{
            name: 'health_check',
            status: 'fail',
            detail: `健康检查执行异常：${err.message}`,
          }],
        }));
      }
    },
  });

  /**
   * GET /api/admin/integrity
   * 验证关键文件完整性（SHA256 校验）
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/integrity',
    handler: function integrityHandler(_req, res) {
      const dataDir = ctx.dataDir || '';
      if (!dataDir) {
        send(res, error('BAD_REQUEST', '数据目录未提供'), 400);
        return;
      }

      const filesToCheck = [
        { name: 'state.json', label: '状态数据' },
      ];

      const results = [];
      for (const file of filesToCheck) {
        const filePath = path.join(dataDir, file.name);
        const result = fileAdmin.verifyFileIntegrity(filePath);
        results.push({ file: file.name, label: file.label, ...result });
      }

      send(res, success({ files: results }));
    },
  });

  /**
   * POST /api/admin/restore
   * 从备份恢复数据
   * 需要请求体含 backupFile 字段
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/restore',
    handler: async function restoreHandler(req, res) {
      const dataDir = ctx.dataDir || '';
      const sessionService = ctx.sessionService;

      if (!dataDir || !sessionService) {
        send(res, error('BAD_REQUEST', '数据目录或 session 服务未提供'), 400);
        return;
      }

      let body;
      try {
        body = await parseBody(req);
      } catch (err) {
        if (err.code === 'PAYLOAD_TOO_LARGE') {
          send(res, error('PAYLOAD_TOO_LARGE', err.message), 413);
          return;
        }
        send(res, error('BAD_REQUEST', '无效请求体'), 400);
        return;
      }

      if (!body || !body.backupFile) {
        send(res, error('BAD_REQUEST', '恢复操作需要 backupFile 字段'), 400);
        return;
      }

      const backupPath = path.join(dataDir, body.backupFile);
      if (!fs.existsSync(backupPath)) {
        send(res, error('NOT_FOUND', '备份文件不存在'), 404);
        return;
      }

      try {
        const backupContent = fs.readFileSync(backupPath, 'utf8');
        const backupData = JSON.parse(backupContent);

        if (!backupData.sessions || !backupData.routes) {
          send(res, error('BAD_REQUEST', '备份文件格式无效'), 400);
          return;
        }

        const currentData = sessionService.stateStore.read();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const preRestoreBackup = path.join(dataDir, `state.json.pre-restore-${timestamp}`);
        fs.writeFileSync(preRestoreBackup, JSON.stringify(currentData, null, 2), 'utf8');

        sessionService.stateStore.write({
          sessions: backupData.sessions,
          routes: backupData.routes,
        });

        recordEvent(ctx.eventStore, {
          type: 'maintenance.restore',
          message: '数据已从备份恢复',
          data: { backupFile: body.backupFile, preRestoreBackup },
        });

        send(res, success({ restored: true, backupFile: body.backupFile, preRestoreBackup }));
      } catch (err) {
        send(res, error('INTERNAL_ERROR', `恢复失败：${err.message}`), 500);
      }
    },
  });

  /**
   * POST /api/admin/rotate-logs
   * 日志轮转：当日志文件超过指定大小时，将其重命名为带时间戳的备份文件
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/rotate-logs',
    handler: async function rotateLogsHandler(req, res) {
      const dataDir = ctx.dataDir || '';
      if (!dataDir) {
        send(res, error('BAD_REQUEST', '数据目录未提供'), 400);
        return;
      }

      let body;
      try {
        body = await parseBody(req);
      } catch (err) {
        if (err.code === 'PAYLOAD_TOO_LARGE') {
          send(res, error('PAYLOAD_TOO_LARGE', err.message), 413);
          return;
        }
        send(res, error('BAD_REQUEST', '无效请求体'), 400);
        return;
      }

      const result = fileAdmin.rotateLogs(dataDir, {
        maxSizeMB: body && body.maxSizeMB ? body.maxSizeMB : 10,
        maxBackups: body && body.maxBackups ? body.maxBackups : 5,
      });

      recordEvent(ctx.eventStore, {
        type: 'maintenance.rotate-logs',
        message: '日志轮转完成',
        data: result,
      });

      send(res, success(result));
    },
  });

  /**
   * POST /api/admin/attachments/:sessionId/cleanup
   * 清理指定 session 的附件
   * 需要请求体含 confirm=true 才执行清理
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/attachments/:sessionId/cleanup',
    handler: async function sessionAttachmentsCleanupHandler(req, res, params) {
      const dataDir = ctx.dataDir || '';
      if (!dataDir) {
        send(res, error('BAD_REQUEST', '数据目录未提供'), 400);
        return;
      }

      let body;
      try {
        body = await parseBody(req);
      } catch (err) {
        if (err.code === 'PAYLOAD_TOO_LARGE') {
          send(res, error('PAYLOAD_TOO_LARGE', err.message), 413);
          return;
        }
        send(res, error('BAD_REQUEST', '无效请求体'), 400);
        return;
      }

      if (!body || body.confirmed !== true) {
        send(res, error('BAD_REQUEST', '清理操作需要 confirmed=true 确认'), 400);
        return;
      }

      const result = fileAdmin.cleanupSessionAttachments(
        dataDir,
        params.sessionId,
        true,
      );

      recordEvent(ctx.eventStore, {
        type: 'attachment.cleanup',
        message: 'Session 附件已清理',
        data: { sessionId: params.sessionId, ...result },
      });

      send(res, success(result));
    },
  });

  /**
   * GET /api/admin/health/history
   * 获取健康检查历史记录
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/health/history',
    handler: function healthHistoryHandler(req, res) {
      const qs = req.queryString || '';
      const params = parseQueryString(qs);
      const limit = params.limit ? parseInt(params.limit, 10) : 20;
      const history = diagnostics.getHealthHistory(limit);
      send(res, success({ history, total: history.length }));
    },
  });

  /**
   * DELETE /api/admin/health/history
   * 清空健康检查历史记录
   */
  routes.push({
    method: 'DELETE',
    pattern: '/api/admin/health/history',
    handler: function clearHealthHistoryHandler(_req, res) {
      const result = diagnostics.clearHealthHistory();
      send(res, success(result));
    },
  });

  return routes;
}

module.exports = { createMaintenanceRoutes };
