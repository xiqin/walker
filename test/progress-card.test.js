const test = require('node:test');
const assert = require('node:assert/strict');
const { ProgressCard, formatAgentEvent, truncateText } = require('../src/platform/feishu/progress-card');

test('ProgressCard 初始状态为 thinking', () => {
  const pc = new ProgressCard({ sessionId: 'wks_test' });
  const card = pc.render();
  assert.ok(card.header);
  assert.equal(card.header.template, 'turquoise');
});

test('ProgressCard render 开启多端同步更新', () => {
  const pc = new ProgressCard({ sessionId: 'wks_test' });
  const card = pc.render();
  assert.equal(card.config.update_multi, true);
});

test('ProgressCard append text 事件后切换到 working', () => {
  const pc = new ProgressCard({ sessionId: 'wks_test' });
  pc.append({ type: 'text', text: '开始处理你的请求' });
  const card = pc.render();
  assert.equal(card.header.template, 'blue');
});

test('ProgressCard append tool_use 事件显示工具名称', () => {
  const pc = new ProgressCard({ sessionId: 'wks_test' });
  pc.append({ type: 'text', text: '正在处理...' });
  pc.append({ type: 'tool_use', name: 'Bash', input: 'ls -la', status: 'done' });
  const card = pc.render();
  const textEls = card.elements.filter((el) => el.tag === 'div' && el.text);
  assert.ok(textEls.some((el) => el.text.content.includes('Bash')));
});

test('ProgressCard done 后切换到 done 模板', () => {
  const pc = new ProgressCard({ sessionId: 'wks_test' });
  pc.append({ type: 'text', text: '结果' });
  pc.markDone();
  const card = pc.render();
  assert.equal(card.header.template, 'green');
});

test('ProgressCard append done 事件后保留已有内容并切换完成', () => {
  const pc = new ProgressCard({ sessionId: 'wks_test' });
  pc.append({ type: 'text', text: '最终回答' });
  pc.append({ type: 'done', data: { reason: 'idle' } });
  const card = pc.render();
  assert.equal(card.header.template, 'green');
  assert.ok(card.elements.some((el) => el.text.content.includes('最终回答')));
});

test('ProgressCard 连续 text delta 事件合并为一段回答', () => {
  const pc = new ProgressCard({ sessionId: 'wks_test' });
  pc.append({ type: 'text', data: { text: '你', delta: true } });
  pc.append({ type: 'text', data: { text: '好', delta: true } });
  const card = pc.render();
  assert.equal(card.elements.length, 1);
  assert.ok(card.elements[0].text.content.includes('你好'));
});

test('ProgressCard error 事件切换到 red 模板', () => {
  const pc = new ProgressCard({ sessionId: 'wks_test' });
  pc.append({ type: 'error', error: new Error('api failed'), recoverable: true });
  const card = pc.render();
  assert.equal(card.header.template, 'red');
});

test('ProgressCard append 多个事件后渲染包含所有内容', () => {
  const pc = new ProgressCard({ sessionId: 'wks_test' });
  pc.append({ type: 'text', text: '第一段' });
  pc.append({ type: 'tool_use', name: 'Read', status: 'done' });
  pc.append({ type: 'text', text: '第二段' });
  const card = pc.render();
  assert.ok(card.elements.length >= 3);
});

test('ProgressCard patchFailed 时返回新消息指令', () => {
  const pc = new ProgressCard({ sessionId: 'wks_test' });
  pc.append({ type: 'text', text: '一些内容' });
  const result = pc.handlePatchFailure();
  assert.equal(result.strategy, 'new_message');
});

test('formatAgentEvent text 事件', () => {
  const formatted = formatAgentEvent({ type: 'text', text: 'hello' });
  assert.ok(formatted.includes('hello'));
});

test('formatAgentEvent tool_use 事件', () => {
  const formatted = formatAgentEvent({ type: 'tool_use', name: 'Bash', status: 'done' });
  assert.ok(formatted.includes('Bash'));
});

test('formatAgentEvent error 事件', () => {
  const formatted = formatAgentEvent({ type: 'error', error: new Error('oops') });
  assert.ok(formatted.includes('oops'));
});

test('formatAgentEvent reasoning 事件', () => {
  const formatted = formatAgentEvent({ type: 'reasoning', text: '分析中' });
  assert.ok(formatted.includes('分析中'));
});

test('truncateText 长文本被截断', () => {
  const long = 'a'.repeat(500);
  const truncated = truncateText(long, 100);
  assert.ok(truncated.length < 200);
  assert.ok(truncated.endsWith('...'));
});

test('truncateText 短文本不截断', () => {
  const short = 'hello world';
  assert.equal(truncateText(short, 100), short);
});

test('ProgressCard getCardId 返回卡片标识', () => {
  const pc = new ProgressCard({ sessionId: 'wks_test', cardMessageId: 'om_card1' });
  assert.equal(pc.getCardId(), 'om_card1');
});
