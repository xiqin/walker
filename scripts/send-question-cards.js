'use strict';

const { loadEnvConfig } = require('../src/config/env');
const config = loadEnvConfig();
const { FeishuApi } = require('../src/platform/feishu/api');
const { buildQuestionCard, buildQuestionRepliedCard } = require('../src/platform/feishu/cards');

const CHAT_ID = process.argv[2] || 'oc_caddb493a5a1f27a722a0419f8b30261';

async function main() {
  const feishuApi = new FeishuApi({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
  });

  const cards = [
    {
      name: 'question_confirm',
      event: {
        data: {
          id: 'q_preview_confirm',
          title: '是否允许执行此操作？',
          type: 'question',
          metadata: { inputMode: 'confirm', description: 'Agent 请求执行 shell 命令' },
        },
      },
    },
    {
      name: 'question_single_select',
      event: {
        data: {
          id: 'q_preview_select',
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
    },
    {
      name: 'question_multi_select',
      event: {
        data: {
          id: 'q_preview_multi',
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
    },
    {
      name: 'question_text',
      event: {
        data: {
          id: 'q_preview_text',
          title: '请输入提交信息',
          type: 'question',
          metadata: { inputMode: 'text', description: '请输入 git commit message' },
        },
      },
    },
    {
      name: 'question_replied',
      event: null,
      useReplied: true,
      questionId: 'q_preview_confirm',
      answer: 'allow',
    },
    {
      name: 'question_replied_multi',
      event: null,
      useReplied: true,
      questionId: 'q_preview_multi',
      answer: ['unit', 'integration'],
    },
  ];

  for (const c of cards) {
    const card = c.useReplied
      ? buildQuestionRepliedCard(c.questionId, c.answer)
      : buildQuestionCard(c.event, 'preview_session', 'preview_route');

    console.log('Sending card:', c.name);
    try {
      const msgId = await feishuApi.replyCard({ chatId: CHAT_ID }, card);
      console.log('  OK, messageId:', msgId);
    } catch (err) {
      console.error('  FAIL:', err.message);
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
