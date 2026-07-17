'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('turn-state');

/**
 * Turn 状态机管理器，负责单个 prompt turn 的生命周期、取消、超时与状态查询。
 *
 * 共享状态（turnStates / cancelledTurnSessions / _turnSeq）仍挂在 dispatcher 实例上，
 * 以保持测试和外部访问的向后兼容（测试直接 dispatcher.turnStates.set/get）。
 */
class TurnStateManager {
  /**
   * @param {Object} options
   * @param {Object} options.dispatcher - MessageDispatcher 实例，用于访问共享状态与主类方法
   * @param {Object} options.sessionService - 会话服务
   * @param {Object} options.driverRegistry - Agent 驱动注册表
   * @param {number} [options.maxTurnTimeMins=0] - 单 turn 最大时长（分钟），0 表示不限制
   */
  constructor({ dispatcher, sessionService, driverRegistry, maxTurnTimeMins }) {
    this.dispatcher = dispatcher;
    this.sessionService = sessionService;
    this.driverRegistry = driverRegistry;
    this.maxTurnTimeMins = maxTurnTimeMins || 0;
  }

  /**
   * 启动一个新的 turn 状态记录
   * @param {Object} session - 会话对象
   * @param {Object} event - 原始消息事件
   * @param {Object} driver - Agent 驱动
   * @param {Object} agentRef - Agent 引用
   * @param {number} token - turn 序号
   * @param {string|null} progressCardId - 进度卡片消息 ID
   * @param {Function} stopHeartbeat - 停止心跳的函数
   * @returns {Object} turnState 对象
   */
  _startTurnState(session, event, driver, agentRef, token, progressCardId, stopHeartbeat) {
    this.dispatcher.cancelledTurnSessions.delete(session.id);
    const turnState = {
      token,
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      progressCardId,
      cancelled: false,
      abortController: new AbortController(),
      cancelReason: null,
      timeoutTimer: null,
      stopHeartbeat,
      event,
      driver,
      agentRef,
    };
    this.dispatcher.turnStates.set(session.id, turnState);
    this._startTurnTimeout(session, turnState);
    return turnState;
  }

  /**
   * 为 turn 启动超时定时器，到时自动取消
   * @param {Object} session - 会话对象
   * @param {Object} turnState - turn 状态对象
   */
  _startTurnTimeout(session, turnState) {
    if (!this.maxTurnTimeMins || this.maxTurnTimeMins <= 0) return;
    const timeoutMs = Math.max(1, this.maxTurnTimeMins * 60 * 1000);
    turnState.timeoutTimer = setTimeout(() => {
      turnState.cancelReason = 'deadline';
      if (turnState.abortController) turnState.abortController.abort();
      this._cancelTurn(session, turnState.driver, turnState, { reason: 'deadline' })
        .then(() => this.dispatcher._callFeishu('replyText', [this.dispatcher._replyCtx(turnState.event), 'Current turn timed out after ' + this.maxTurnTimeMins + ' minutes and was cancelled.']))
        .catch((err) => logger.warn('turn timeout cancel failed', { sessionId: session.id, error: err && err.message ? err.message : String(err) }));
    }, timeoutMs);
    if (turnState.timeoutTimer && typeof turnState.timeoutTimer.unref === 'function') turnState.timeoutTimer.unref();
  }

  /**
   * 取消一个进行中的 turn，触发 driver 取消并清理状态
   * @param {Object} session - 会话对象
   * @param {Object} driver - Agent 驱动
   * @param {Object} turnState - turn 状态对象
   * @param {Object} [options] - 附加选项，含 reason
   */
  async _cancelTurn(session, driver, turnState, options) {
    if (!session || !turnState || turnState.cancelled) return;
    turnState.cancelled = true;
    if (options && options.reason) turnState.cancelReason = options.reason;
    this.dispatcher.cancelledTurnSessions.add(session.id);
    if (turnState.abortController && !turnState.abortController.signal.aborted) {
      turnState.abortController.abort();
    }
    this._clearTurnState(session.id, turnState.token);
    this.dispatcher.sessionWatchBuffers.set(session.id, []);
    const activeDriver = driver || this.driverRegistry.get(session.agent);
    if (activeDriver && session.agentRef) {
      if (typeof activeDriver.cancel === 'function') {
        await activeDriver.cancel(session.agentRef);
      } else if (typeof activeDriver.stop === 'function') {
        await activeDriver.stop(session.agentRef);
      }
    }
    this.dispatcher._markIdleIfActive(session.id);
    logger.info('turn cancelled', { sessionId: session.id, reason: options && options.reason });
  }

  /**
   * 清除 turn 状态（匹配 token），停止心跳与超时定时器
   * @param {string} sessionId - 会话 ID
   * @param {number} [token] - turn 序号，不匹配时跳过清除
   */
  _clearTurnState(sessionId, token) {
    const turnState = this.dispatcher.turnStates.get(sessionId);
    if (!turnState || (token && turnState.token !== token)) return;
    if (turnState.timeoutTimer) clearTimeout(turnState.timeoutTimer);
    if (turnState.stopHeartbeat) {
      try { turnState.stopHeartbeat(); } catch (_) {}
    }
    this.dispatcher.turnStates.delete(sessionId);
  }

  /**
   * 判断指定 turn 是否已被取消
   * @param {string} sessionId - 会话 ID
   * @param {number} token - turn 序号
   * @returns {boolean}
   */
  _isTurnCancelled(sessionId, token) {
    const turnState = this.dispatcher.turnStates.get(sessionId);
    return this.dispatcher.cancelledTurnSessions.has(sessionId) || !!(turnState && turnState.token === token && turnState.cancelled);
  }

  /**
   * 判断指定 session 的输出是否应被抑制（已取消的 turn）
   * @param {string} sessionId - 会话 ID
   * @returns {boolean}
   */
  _isTurnSuppressed(sessionId) {
    return this.dispatcher.cancelledTurnSessions.has(sessionId);
  }

  /**
   * 更新 turn 的最近事件时间戳
   * @param {Object} turnState - turn 状态对象
   */
  _touchTurnState(turnState) {
    if (turnState) turnState.lastEventAt = Date.now();
  }

  /**
   * 判断错误是否为可恢复的传输层错误（SSE 超时、TUI 断连等）
   * @param {Error} err - 错误对象
   * @returns {boolean}
   */
  _isTransportRecoverableError(err) {
    if (!err) return false;
    const code = err.code;
    if (code === 'SSE_IDLE_TIMEOUT' || code === 'SSE_OPEN_TIMEOUT') return true;
    if (code === 'TUI_RUNTIME_DISCONNECTED') return true;
    if (!code && err.message && /idle|timed out|SSE connection/i.test(err.message)) return true;
    return false;
  }
}

module.exports = { TurnStateManager };
