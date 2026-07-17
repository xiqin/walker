'use strict';

const { AgentEvent } = require('../drivers/agent-driver');

/**
 * Prompt 心跳管理器，在 prompt 执行期间定期更新进度卡片以提示用户任务仍在进行。
 *
 * 共享状态（promptHeartbeatStops）仍挂在 dispatcher 实例上，以保持向后兼容。
 */
class PromptHeartbeat {
  /**
   * @param {Object} options
   * @param {Object} options.dispatcher - MessageDispatcher 实例
   * @param {Object} options.feishuApi - 飞书 API 代理
   * @param {number} [options.initialMs] - 首次心跳延迟（毫秒）
   * @param {number} [options.intervalMs] - 后续心跳间隔（毫秒）
   * @param {number} [options.stuckMs] - 判定卡住的阈值（毫秒）
   * @param {string} [options.progressStyle] - 进度展示风格
   */
  constructor({ dispatcher, feishuApi, initialMs, intervalMs, stuckMs, progressStyle }) {
    this.dispatcher = dispatcher;
    this.feishuApi = feishuApi;
    this.initialMs = initialMs;
    this.intervalMs = intervalMs;
    this.stuckMs = stuckMs;
    this.progressStyle = progressStyle;
  }

  /**
   * 启动 prompt 心跳，定期更新进度卡片提示任务进行中
   * @param {Object} session - 会话对象
   * @param {string|null} progressCardId - 进度卡片消息 ID
   * @returns {Function} 停止心跳的函数
   */
  start(session, progressCardId) {
    if (this.progressStyle !== 'card' || !progressCardId || !session || !session.id) return () => {};
    const sessionId = session.id;
    this.stop(sessionId);

    const startedAt = Date.now();
    const initialMs = Math.max(1, this.initialMs);
    const intervalMs = Math.max(1, this.intervalMs);
    const stuckMs = Math.max(initialMs, this.stuckMs);
    let timer = null;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      if (this.dispatcher._isTerminalSession(sessionId)) {
        this.stop(sessionId);
        return;
      }

      const elapsedMs = Date.now() - startedAt;
      const elapsedText = this._formatDuration(elapsedMs);
      const stuck = elapsedMs >= stuckMs;
      const message = stuck
        ? '任务可能卡住，已 ' + elapsedText + ' 无新事件。可以继续等待，或发送 /stop 停止当前 session。'
        : '仍在执行，已等待 ' + elapsedText + '，最近无新事件。';
      this.dispatcher._sendFeishu('updateProgressCard', [progressCardId, sessionId, new AgentEvent(AgentEvent.TYPE_STATUS, { message })], { sessionId });
      timer = setTimeout(tick, intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    };

    timer = setTimeout(tick, initialMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (this.dispatcher.promptHeartbeatStops.get(sessionId) === stop) {
        this.dispatcher.promptHeartbeatStops.delete(sessionId);
      }
    };
    this.dispatcher.promptHeartbeatStops.set(sessionId, stop);
    return stop;
  }

  /**
   * 停止指定 session 的 prompt 心跳
   * @param {string} sessionId - 会话 ID
   */
  stop(sessionId) {
    const stop = this.dispatcher.promptHeartbeatStops.get(sessionId);
    if (stop) {
      try { stop(); } catch (_) {}
    }
    this.dispatcher.promptHeartbeatStops.delete(sessionId);
  }

  /**
   * 将毫秒时长格式化为中文可读字符串
   * @param {number} ms - 毫秒数
   * @returns {string} 格式化后的时长描述
   */
  _formatDuration(ms) {
    const totalSeconds = Math.max(1, Math.round(ms / 1000));
    if (totalSeconds < 60) return totalSeconds + ' 秒';
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (!seconds) return minutes + ' 分钟';
    return minutes + ' 分钟 ' + seconds + ' 秒';
  }
}

module.exports = { PromptHeartbeat };
