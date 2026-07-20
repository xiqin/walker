'use strict';

const { loadEnvConfig } = require('../src/config/env');
const config = loadEnvConfig();
const { FeishuApi } = require('../src/platform/feishu/api');

const CHAT_ID = process.argv[2] || 'oc_caddb493a5a1f27a722a0419f8b30261';

async function main() {
  const feishuApi = new FeishuApi({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
  });

  const card1 = {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: 'multi_select 带 description 字段' }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '**测试飞书 multi_select_static option description 字段**' } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'multi_select_static',
            name: 'test_desc',
            options: [
              {
                text: { tag: 'plain_text', content: '蓝绿部署' },
                description: { tag: 'plain_text', content: '零停机切换，需双倍资源' },
                value: 'bluegreen',
              },
              {
                text: { tag: 'plain_text', content: '金丝雀发布' },
                description: { tag: 'plain_text', content: '逐步放量，适合大流量服务' },
                value: 'canary',
              },
            ],
          },
          { tag: 'button', text: { tag: 'plain_text', content: '提交' }, type: 'primary', value: { action: 'noop' } },
        ],
      },
    ],
  };

  const card2 = {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: 'button 换行带 description' }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '**测试飞书 button text 换行显示 description**' } },
      {
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '蓝绿部署\n零停机切换，需双倍资源' }, type: 'default', value: { action: 'noop1' } },
          { tag: 'button', text: { tag: 'plain_text', content: '金丝雀发布\n逐步放量，适合大流量服务' }, type: 'default', value: { action: 'noop2' } },
        ],
      },
    ],
  };

  console.log('Sending card1 (multi_select with description field)...');
  try {
    const msgId = await feishuApi.replyCard({ chatId: CHAT_ID }, card1);
    console.log('  OK:', msgId);
  } catch (err) {
    console.error('  FAIL:', err.message);
  }

  console.log('Sending card2 (button with newline description)...');
  try {
    const msgId = await feishuApi.replyCard({ chatId: CHAT_ID }, card2);
    console.log('  OK:', msgId);
  } catch (err) {
    console.error('  FAIL:', err.message);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
