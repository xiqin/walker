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

  const card = {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: 'multi_select text 换行带 description' }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '**测试 multi_select option text 换行**' } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'multi_select_static',
            name: 'test_desc',
            options: [
              {
                text: { tag: 'plain_text', content: '蓝绿部署\n零停机切换，需双倍资源' },
                value: 'bluegreen',
              },
              {
                text: { tag: 'plain_text', content: '金丝雀发布\n逐步放量，适合大流量服务' },
                value: 'canary',
              },
              {
                text: { tag: 'plain_text', content: '滚动更新\n默认策略，逐个替换实例' },
                value: 'rolling',
              },
            ],
          },
          { tag: 'button', text: { tag: 'plain_text', content: '提交' }, type: 'primary', value: { action: 'noop' } },
        ],
      },
    ],
  };

  console.log('Sending card (multi_select text with newline)...');
  try {
    const msgId = await feishuApi.replyCard({ chatId: CHAT_ID }, card);
    console.log('OK:', msgId);
  } catch (err) {
    console.error('FAIL:', err.message);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
