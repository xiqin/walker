'use strict';

/**
 * 服务控制模块
 * 二次确认后调用注入的 stopApp 函数停止服务
 * 响应后通过注入的 exitProcess 延迟退出进程
 * 无 confirm=true 返回 400 错误
 * REQ-024
 */

/**
 * 处理服务停止请求
 * 必须要求 confirm=true 才执行停止，否则返回 400
 * 响应成功后通过注入的 exitProcess 延迟退出
 * @param {Object} req - HTTP 请求
 * @param {Object} res - HTTP 响应
 * @param {Object} ctx - 应用上下文
 * @param {Object} ctx.eventStore - 事件存储实例
 * @param {Object} deps - 注入依赖
 * @param {Function} deps.stopApp - 停止应用的函数
 * @param {Function} deps.exitProcess - 退出进程的函数，默认 process.exit
 * @param {Object} deps.response - 响应模块（send, success, error）
 * @param {Function} [deps.parseBodyFn] - 解析请求体的函数，默认 auth.parseBody
 */
function handleServiceStop(req, res, ctx, deps) {
  var response = deps.response;
  var parseBodyFn = deps.parseBodyFn || require('./auth').parseBody;
  var stopApp = deps.stopApp;
  var exitProcess = deps.exitProcess || process.exit;
  var recordEventFn = deps.recordEventFn || require('./event-store').recordEvent;

  parseBodyFn(req, function (body) {
    if (!body || body.confirm !== true) {
      recordEventFn(ctx.eventStore, {
        type: 'admin.action',
        level: 'warn',
        message: '服务停止请求被拒绝：缺少 confirm=true',
      });
      response.send(res, response.error('BAD_REQUEST', '服务停止需要 confirm=true 确认'), 400);
      return;
    }

    recordEventFn(ctx.eventStore, {
      type: 'admin.action',
      level: 'info',
      message: '服务停止请求已确认，准备停止',
    });

    if (!stopApp) {
      response.send(res, response.error('INTERNAL_ERROR', 'stopApp 函数未注入'), 500);
      return;
    }

    stopApp().then(function (stopResult) {
      recordEventFn(ctx.eventStore, {
        type: 'admin.action',
        level: 'info',
        message: '服务已停止',
        data: { stopResult: stopResult },
      });

      response.send(res, response.success({ stopped: true, info: stopResult }));

      setTimeout(function () {
        exitProcess(0);
      }, 500);
    }).catch(function (err) {
      recordEventFn(ctx.eventStore, {
        type: 'admin.error',
        level: 'error',
        message: '服务停止失败：' + (err.message || 'unknown'),
      });
      response.send(res, response.error('INTERNAL_ERROR', '停止服务失败：' + (err.message || 'unknown')), 500);
    });
  });
}

module.exports = { handleServiceStop };
