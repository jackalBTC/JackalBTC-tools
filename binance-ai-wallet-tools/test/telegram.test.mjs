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
test('雷达日志：付费项目简报 → PAID，每段一行', () => {
  const m = parseRadarLine('2026/10/31 21:53:05 PAID ca:0x0000000000000000000000000000000000000001 Example Card：每张 0.002 BNB｜近 5000 块 120 个钱包铸造｜要求 Agent ID');
  assert.equal(m.kind, 'PAID');
  assert.match(m.text, /付费项目/);
  assert.match(m.text, /每张 0\.002 BNB\n近 5000 块/);
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

import { formatNews, newsList } from '../src/telegram/format.mjs';
test('项目动态：用台账里的项目名，带等级图标、建议动作和原帖', () => {
  const m = formatNews({ ts: '2026-10-29T10:00:00Z', project: 'p1', level: '机会', title: '开放市场', summary: '可以挂单了', action: '去看地板价', url: 'https://x.com/p1/status/12345678' }, [{ id: 'p1', name: '项目一' }]);
  assert.equal(m.kind, 'NEWS');
  assert.match(m.text, /💡 项目动态 · 机会\n项目一：开放市场\n可以挂单了\n→ 去看地板价\nhttps:\/\/x\.com\/p1\/status\/12345678/);
});
test('项目动态：链接不是 X 原帖就不带；列表按时间倒序最多 5 条', () => {
  assert.doesNotMatch(formatNews({ project: 'p', title: 't', summary: 's', url: 'javascript:alert(1)' }).text, /javascript/);
  const news = Array.from({ length: 7 }, (_, i) => ({ ts: `2026-10-29T0${i}:00:00Z`, project: 'p', level: '一般', title: 'T' + i, summary: 's' }));
  const out = newsList(news);
  assert.match(out, /T6/); assert.doesNotMatch(out, /T1/);
  assert.match(newsList([]), /还没有/);
});

import { costLine } from '../src/telegram/format.mjs';
test('铸造成功：付费的写付了多少 + gas，免费的写 gas', () => {
  const tx = '0x' + 'b'.repeat(64);
  const paid = formatEvent({ action: 'confirm', project: 'p', detail: 'status=0x1', txHash: tx }, { valueWei: 2500000000000000n, gasWei: 30000000000000n, bnbUsd: 700 }).text;
  assert.match(paid, /付费 0\.0025 BNB（≈\$1\.75） \+ gas 0\.00003 BNB（≈\$0\.02）/);
  assert.match(formatEvent({ action: 'confirm', project: 'p', detail: 'status=0x1' }, { valueWei: 0n, gasWei: 21000000000000n, bnbUsd: 700 }).text, /免费 · gas 0\.000021 BNB/);
  assert.equal(costLine(null), '');
  assert.doesNotMatch(formatEvent({ action: 'confirm', project: 'p', detail: 'status=0x1' }).text, /💰/);
});

test('多钱包：铸造消息注明是哪个钱包', () => {
  assert.match(formatEvent({ action: 'confirm', project: 'p', detail: 'status=0x1', wallet: 'w2' }).text, /铸造成功：p（钱包 w2）/);
});
