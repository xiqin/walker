'use strict';

const { loadEnvConfig } = require('../src/config/env');
const config = loadEnvConfig();
const { FeishuApi } = require('../src/platform/feishu/api');
const { buildQuestionCard } = require('../src/platform/feishu/cards');

const CHAT_ID = process.argv[2] || 'oc_caddb493a5a1f27a722a0419f8b30261';

async function main() {
  const feishuApi = new FeishuApi({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
  });

  const eventWithDesc = {
    data: {
      id: 'q_preview_desc',
      title: '请选择部署策略',
      type: 'question',
      metadata: {
        inputMode: 'multi_select',
        description: '可选择多个策略组合部署',
        options: [
          { label: '蓝绿部署', value: 'bluegreen', description: '零停机切换，需双倍资源' },
          { label: '金丝雀发布', value: 'canary', description: '逐步放量，适合大流量服务' },
          { label: '滚动更新', value: 'rolling', description: '默认策略，逐个替换实例' },
        ],
      },
    },
  };

  const eventSingleWithDesc = {
    data: {
      id: 'q_preview_single_desc',
      title: '请选择部署环境',
      type: 'question',
      metadata: {
        inputMode: 'single_select',
        description: '请选择目标部署环境',
        options: [
          { label: '开发环境', value: 'dev', description: '本地开发调试用' },
          { label: '测试环境', value: 'staging', description: '集成测试与预发布' },
          { label: '生产环境', value: 'prod', description: '面向真实用户' },
        ],
      },
    },
  };

  const card1 = buildQuestionCard(eventWithDesc, 'preview_session', 'preview_route');
  const card2 = buildQuestionCard(eventSingleWithDesc, 'preview_session', 'preview_route');

  console.log('Sending multi_select with description...');
  try {
    const msgId = await feishuApi.replyCard({ chatId: CHAT_ID }, card1);
    console.log('OK:', msgId);
  } catch (err) {
    console.error('FAIL:', err.message);
  }

  console.log('Sending single_select with description...');
  try {
    const msgId = await feishuApi.replyCard({ chatId: CHAT_ID }, card2);
    console.log('OK:', msgId);
  } catch (err) {
    console.error('FAIL:', err.message);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
