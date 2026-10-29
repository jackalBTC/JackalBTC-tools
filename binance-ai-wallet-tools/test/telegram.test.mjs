// Telegram 消息格式化的单元测试。运行：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRadarLine, formatEvent, todaySummary, pendingList } from '../src/telegram/format.mjs';

test('雷达日志：新线索 → 带原帖链接的提醒', () => {
  const m = parseRadarLine('2026/10/29 13:31:28 CANDIDATE site:example.xyz score=7 @someone https://x.com/someone/status/123456789');
  assert.equal(m.kind, 'CANDIDATE');
  assert.match(m.text, /新线索/);
  assert.match(m.text, /https:\/\/x\.com\/someone\/status\/123456789/);
});
test('雷达日志：钱包掉线 / BNB 不足 / 开发者模式 识别成各自类型', () => {
  assert.equal(parseRadarLine('2026/10/29 13:56:26 ERR NOTCONNECTED AI 钱包未登录').kind, 'NOTCONNECTED');
  assert.equal(parseRadarLine('2026/10/29 13:56:26 ERR LOWBNB 钱包 BNB 只剩 0.01').kind, 'LOWBNB');
  assert.equal(parseRadarLine('2026/10/29 13:56:26 ERR DEVMODE 开发者模式将在 10 小时后到期').kind, 'DEVMODE');
});
test('雷达日志：每轮汇总、翻页没取完等技术性提示不推', () => {
  assert.equal(parseRadarLine('2026/10/29 13:56:06 ROUND 数据源 twitterapi 请求 6'), null);
  assert.equal(parseRadarLine('2026/10/29 13:56:05 ERR agentid-zh 本轮结果超过 2 页，较早的推文没取完'), null);
  assert.equal(parseRadarLine('随便一行'), null);
});
test('雷达日志：控制字符被去掉，伪造不出第二条消息', () => {
  const m = parseRadarLine('2026/10/29 13:31:28 UPDATE @a https://x.com/a/status/1234567 正文\u2028第二行\u0007');
  assert.ok(!/[\u2028\u0007]/.test(m.text));
});
test('操作日志：只推铸造成功、等你决定、中止', () => {
  const tx = '0x' + 'a'.repeat(64);
  assert.equal(formatEvent({ action: 'confirm', project: 'demo', detail: '回执 status=0x1，到手 #1', txHash: tx }).kind, 'MINT');
  assert.match(formatEvent({ action: 'confirm', project: 'demo', detail: 'status=0x1', txHash: tx }).text, /bscscan\.com\/tx\/0xa+/);
  assert.equal(formatEvent({ action: 'confirm', project: 'demo', detail: '回执 status=0x0' }), null);
  assert.equal(formatEvent({ action: 'brief', project: 'demo', detail: '要付 5 USDT' }).kind, 'PENDING');
  assert.equal(formatEvent({ action: 'abort', project: 'demo', detail: '有授权变化' }).kind, 'ABORT');
  assert.equal(formatEvent({ action: 'verify', project: 'demo', detail: 'x' }), null);
});
test('操作日志：txHash 格式不对就不拼链接', () => {
  assert.doesNotMatch(formatEvent({ action: 'confirm', project: 'p', detail: 'status=0x1', txHash: 'javascript:alert(1)' }).text, /bscscan/);
});
test('今天汇总 / 待确认列表', () => {
  const now = new Date('2026-10-29T12:00:00');
  const ev = [{ action: 'confirm', project: 'a', detail: 'status=0x1', ts: '2026-10-29T03:00:00' }, { action: 'confirm', project: 'a', detail: 'status=0x1', ts: '2026-10-29T05:00:00' }, { action: 'confirm', project: 'b', detail: 'status=0x1', ts: '2026-10-28T05:00:00' }];
  assert.match(todaySummary(ev, now), /2 笔、1 个项目/);
  assert.match(pendingList([]), /没有/);
  assert.match(pendingList([{ status: '待确认', name: 'X', card: { question: '要不要付 3U？' } }]), /X：要不要付 3U？/);
});
