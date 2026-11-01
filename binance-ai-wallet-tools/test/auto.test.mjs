// v0.4.0 新功能的纯逻辑：自动止盈阶段、Element 日志解析、看板分组、自动领取 / 兑换的检查、分段 getLogs、Flap 新盘。运行：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickStage, stageName, costToUsd, LADDER } from '../src/lib/takeprofit.mjs';
import { ELEMENT, TOPICS, parseElementLog, liveBids, marketVerdict, elementSummary } from '../src/lib/element.mjs';
import { tierOf, realizedOf } from '../src/lib/tiers.mjs';
import { validateClaim, checkClaimPreview, findRedeemSample, replayCalldata, checkRedeemPreview } from '../src/lib/auto-rules.mjs';
import { getLogs } from '../src/lib/chain.mjs';
import { flapLine, cleanName } from '../src/radar/flap.mjs';
import { parseRadarLine } from '../src/telegram/format.mjs';
import { mergePositions } from '../src/server/merge.mjs';

const ME = '0x1111111111111111111111111111111111111111', OTHER = '0x2222222222222222222222222222222222222222';
const NFT = '0x3333333333333333333333333333333333333333', TOKEN = '0x4444444444444444444444444444444444444444', REDEEMER = '0x5555555555555555555555555555555555555555';
const E18 = 10n ** 18n;

// ---------- 自动止盈 ----------
const S = (done = {}) => ({ done, costUsd: 10 });
const at = (mult, raw = 1000n * E18, price = 0.01 * mult) => ({ mult, price, raw, decimals: 18 });

test('止盈：不到 3 倍不卖；3 倍卖出相当于本钱的数量', () => {
  assert.equal(pickStage({}, S(), at(2.9)), null);
  const p = pickStage({}, S(), at(3, 1000n * E18, 0.03));   // 成本 $10，现价 $0.03 → 卖 333.33 枚
  assert.equal(p.stage, 'tp3');
  assert.equal(p.amount, 333333333n * 10n ** 12n);
  assert.equal(p.name, '3 倍卖回本钱');
});
test('止盈：本钱比持仓还多时最多卖光', () => {
  assert.equal(pickStage({}, S(), at(3, 100n, 0.03)).amount, 100n);
});
test('止盈：回本之后按阶梯一档一档卖剩余的 20%，从低到高', () => {
  assert.deepEqual(LADDER, [10, 30, 50, 100, 150, 200]);
  const p = pickStage({}, S({ tp3: 'x' }), at(60, 1000n));
  assert.equal(p.stage, 'tp10'); assert.equal(p.amount, 200n);
  assert.equal(pickStage({}, S({ tp3: 'x', tp10: 'x' }), at(60, 1000n)).stage, 'tp30');
  assert.equal(pickStage({}, S({ tp3: 'x', tp10: 'x', tp30: 'x', tp50: 'x' }), at(60, 1000n)), null);
  assert.equal(pickStage({}, S({}), at(60, 1000n)).stage, 'tp3');   // 回本那档没做过，先回本
});
test('止盈：到过 10 倍又跌回 3 倍卖一半；back3: false 不卖；只做一次', () => {
  const s = S({ tp3: 'x', tp10: 'x' });
  const p = pickStage({}, s, at(2.5, 1000n));
  assert.equal(p.stage, 'back3'); assert.equal(p.amount, 500n);
  assert.equal(pickStage({ back3: false }, s, at(2.5, 1000n)), null);
  assert.equal(pickStage({}, S({ tp3: 'x', tp10: 'x', back3: 'x' }), at(2.5, 1000n)), null);
  assert.equal(pickStage({}, S({ tp3: 'x' }), at(2.5, 1000n)), null);   // 没到过 10 倍那档：不卖
});
test('止盈：firstTp 代替 3 倍那档，之后走阶梯', () => {
  const t = { firstTp: { mult: 2, frac: 0.5 } };
  assert.equal(pickStage(t, S(), at(1.9, 1000n)), null);
  const p = pickStage(t, S(), at(2.2, 1000n));
  assert.equal(p.stage, 'tp2'); assert.equal(p.amount, 500n); assert.equal(p.name, '2 倍先卖 50%');
  assert.equal(pickStage(t, S({ tp2: 'x' }), at(5, 1000n)), null);   // 不再有 3 倍那档
  assert.equal(pickStage(t, S({ tp2: 'x' }), at(12, 1000n)).stage, 'tp10');
  assert.equal(pickStage({ firstTp: { mult: 0.5, frac: 0.5 } }, S(), at(3, 1000n, 0.03)).stage, 'tp3');   // 写错的 firstTp 当没写
});
test('止盈：自定 ladder', () => {
  const t = { ladder: [20, 5] };
  assert.equal(pickStage(t, S({ tp3: 'x' }), at(12, 1000n)).stage, 'tp5');
  assert.equal(pickStage(t, S({ tp3: 'x', tp5: 'x' }), at(12, 1000n)), null);
  assert.equal(stageName('tp20', t), '20 倍卖剩余的 20%');
});
test('止盈：hold 只记价格不卖', () => {
  assert.equal(pickStage({ hold: true }, S(), at(50, 1000n)), null);
});
test('止盈：sellOnce 卖一次指定比例，之后什么都不做', () => {
  const t = { sellOnce: 0.5 };
  const p = pickStage(t, S(), at(0.5, 1000n));   // 亏着也卖（代币等于白送）
  assert.equal(p.stage, 'once'); assert.equal(p.amount, 500n); assert.equal(p.name, '一次性卖出 50%');
  assert.equal(pickStage(t, S({ once: 'x' }), at(100, 1000n)), null);
  assert.equal(pickStage({ sellOnce: 2 }, S(), at(100, 1000n)), null);   // 写错不卖
});
test('止盈：没有持仓 / 没有价格不卖；成本折美元', () => {
  assert.equal(pickStage({}, S(), at(5, 0n)), null);
  assert.equal(pickStage({}, { done: {} }, at(5, 1000n)), null);   // 没成本不卖回本那档
  assert.equal(costToUsd({ USDT: 3, BNB: 0.01 }, 600), 9);
  assert.equal(costToUsd({ BNB: 0.01 }, null), null);
  assert.equal(costToUsd({ BNB: 0 }, 600), null);
});

// ---------- Element ----------
const W = v => (typeof v === 'string' ? v.replace(/^0x/, '') : BigInt(v).toString(16)).padStart(64, '0');
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const fillLog = (topic, { maker = OTHER, nonce = 7, cur = '0x0', amount = E18 / 100n, nft = NFT, id = 5 } = {}) =>
  ({ address: ELEMENT, topics: [topic], blockNumber: '0x10', data: '0x' + [W(0), W(maker), W(ME), W(nonce), W(cur), W(amount), W(0x120), W(nft), W(id)].join('') });
const bidLog = ({ maker = OTHER, nonce = 9, expiry, amount = E18 / 50n, nft = NFT, id = 5, cur = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' } = {}) =>
  ({ address: ELEMENT, topics: [TOPICS.bid], blockNumber: '0x11', data: '0x' + [W(maker), W(0), W(expiry), W(nonce), W(cur), W(amount), W(0x140), W(nft), W(id)].join('') });

test('Element：事件签名算对了', () => {
  assert.equal(TOPICS.sell, '0x9c248aa1a265aa616f707b979d57f4529bb63a4fc34dc7fc61fdddc18410f74e');
  assert.equal(TOPICS.buy, '0xd90a5c60975c6ff8eafcf02088e7b50ae5d9e156a79206ba553df1c4fb4594c2');
  assert.equal(TOPICS.cancel, '0xa015ad2dc32f266993958a0fd9884c746b971b254206f3478bc43e2f125c7b9e');
});
test('Element：解析成交（BNB / USDT），别的系列只记作废的单', () => {
  const e = parseElementLog(fillLog(TOPICS.sell), new Set([NFT]));
  assert.deepEqual({ ...e }, { type: 'fill', nft: NFT, id: '5', p: 0.01, cur: 'BNB', key: OTHER + ':7', blk: 16 });
  assert.equal(parseElementLog(fillLog(TOPICS.buy, { cur: USDT, amount: 3n * E18 })).cur, 'USDT');
  assert.deepEqual(parseElementLog(fillLog(TOPICS.sell, { nft: TOKEN }), new Set([NFT])), { type: 'used', key: OTHER + ':7' });
  assert.equal(parseElementLog(fillLog(TOPICS.sell, { cur: TOKEN })).type, 'used');   // 不认识的计价币不算价格
  assert.equal(parseElementLog({ topics: ['0x' + '1'.repeat(64)], data: '0x' }), null);
});
test('Element：求购的到期时间只取 expiry 的低 32 位', () => {
  const exp = 1893456000n, packed = (123456789n << 32n) | exp;   // 高位塞了别的数
  const e = parseElementLog(bidLog({ expiry: packed }));
  assert.equal(e.type, 'bid'); assert.equal(e.exp, Number(exp)); assert.equal(e.p, 0.02); assert.equal(e.cur, 'BNB');
});
test('Element：撤单', () => {
  const l = { topics: [TOPICS.cancel], data: '0x' + W(OTHER) + W(9) };
  assert.deepEqual(parseElementLog(l), { type: 'cancel', key: OTHER + ':9' });
});
test('Element：有效求购只算收我们编号的、没过期的、没撤的', () => {
  const now = 1_800_000_000;
  const ev = [
    { type: 'bid', id: '5', exp: now + 100, key: 'a:1', p: 1, cur: 'BNB' },
    { type: 'bid', id: '6', exp: now + 100, key: 'a:2', p: 1, cur: 'BNB' },   // 不是我们的编号
    { type: 'bid', id: '5', exp: now - 1, key: 'a:3', p: 1, cur: 'BNB' },     // 过期
    { type: 'bid', id: '5', exp: now + 100, key: 'a:4', p: 1, cur: 'BNB' },   // 撤了
    { type: 'fill', id: '5', key: 'b:1', p: 1, cur: 'BNB' },
  ];
  assert.deepEqual(liveBids(ev, { 'a:4': 1 }, [5], now).map(e => e.key), ['a:1']);
});
test('Element：报的规则（≥3 笔成交且最近一笔 ≥$2，或求购 ≥$5）', () => {
  const now = Date.now(), f = (usd, ago = 3600e3) => ({ type: 'fill', id: '1', p: usd, cur: 'USDT', key: 'k', ts: now - ago });
  const base = { used: {}, ourIds: ['5'], now, bnbUsd: 600 };
  assert.equal(marketVerdict([f(3), f(3)], base), null);
  assert.ok(marketVerdict([f(3), f(3), f(2)], base).hot);
  assert.equal(marketVerdict([f(3), f(3), f(1)], base), null);              // 最近一笔太便宜
  assert.equal(marketVerdict([f(3, 4 * 86400e3), f(3), f(3)], base), null);  // 超过 3 天的不算
  const bid = (p, id = '5') => ({ type: 'bid', id, exp: Math.floor(now / 1000) + 3600, key: 'm:' + p + id, p, cur: 'BNB' });
  assert.ok(marketVerdict([bid(0.01)], base).bid);              // 0.01 BNB × 600 = $6
  assert.equal(marketVerdict([bid(0.005)], base), null);        // $3
  assert.equal(marketVerdict([bid(1, '6')], base), null);       // 不收我们的编号
});
test('Element：看板摘要按编号取最高求购', () => {
  const now = Date.now(), exp = Math.floor(now / 1000) + 99;
  const s = elementSummary([{ type: 'fill', p: 0.1, cur: 'BNB', ts: now }, { type: 'bid', id: '5', exp, key: 'x', p: 0.2, cur: 'BNB' }, { type: 'bid', id: '5', exp, key: 'y', p: 0.3, cur: 'BNB' }], {}, [5], now);
  assert.equal(s.fills, 1); assert.equal(s.bids, 1); assert.deepEqual(s.best, { 5: 0.3 });
  assert.equal(elementSummary([], {}, [5]), null);
});

// ---------- 分段 getLogs ----------
test('getLogs：按 maxRange 分段；RPC 嫌范围大就减半重试', async () => {
  const calls = [];
  const call = async f => { const a = Number(f.fromBlock), b = Number(f.toBlock); calls.push([a, b]); if (b - a + 1 > 5000) throw new Error('block range exceeds limit 5000'); return [{ a }]; };
  const logs = await getLogs({ address: ELEMENT }, 1, 12000, { maxRange: 20000, call });
  for (const [a, b] of calls.slice(1)) assert.ok(b - a + 1 <= 20000);
  const ok = calls.filter(([a, b]) => b - a + 1 <= 5000);
  assert.equal(ok[0][0], 1); assert.equal(ok[ok.length - 1][1], 12000);
  for (let i = 1; i < ok.length; i++) assert.equal(ok[i][0], ok[i - 1][1] + 1);   // 不漏块、不重叠
  assert.equal(logs.length, ok.length);
  await assert.rejects(getLogs({}, 1, 10, { call: async () => { throw new Error('connection reset'); } }), /reset/);   // 其他错误直接抛
});

// ---------- 看板分组 ----------
test('看板分组：已核销 > 已清仓 > 能卖 > 有市场没买家 > 新打的 / 沉寂', () => {
  const now = Date.now(), old = now - 10 * 86400e3;
  assert.equal(tierOf({ writtenOff: { label: '归零' }, held: 0 }, now), 'dead');
  assert.equal(tierOf({ held: 0, floor: 1 }, now), 'exit');
  assert.equal(tierOf({ held: 2, floor: 0.01 }, now), 'open');
  assert.equal(tierOf({ held: 2, bid: 0.01 }, now), 'open');
  assert.equal(tierOf({ held: 2, el: { fills: 4 }, marketType: 'none', firstMint: old }, now), 'nobid');
  assert.equal(tierOf({ held: 2, marketType: 'link', firstMint: old }, now), 'nobid');
  assert.equal(tierOf({ held: 2, marketType: 'dex', kind: 'token', firstMint: old }, now), 'idle');   // DEX 没报价 = 没开盘，不算有市场
  assert.equal(tierOf({ held: 2, marketType: 'none', firstMint: now - 3600e3 }, now), 'new');
  assert.equal(tierOf({ held: 2, marketType: 'none', firstMint: old, lastNews: now - 86400e3 }, now), 'new');
  assert.equal(tierOf({ held: 2, marketType: 'none' }, now), 'new');
  assert.equal(tierOf({ held: 2, marketType: 'none', firstMint: old }, now), 'idle');
});
test('已实现盈亏：按项目和钱包合计，没 wallet 字段的算主钱包', () => {
  const L = [{ project: 'a', cost: { USDT: 1 }, proceeds: { BNB: 0.01 }, qty: 10 }, { project: 'a', wallet: 'w2', cost: { USDT: 2 }, proceeds: { USDT: 5 } }, { project: 'b', cost: { USDT: 9 } }];
  assert.deepEqual(realizedOf(L, 'a', 'main', 'main'), { n: 1, cost: { USDT: 1 }, proceeds: { BNB: 0.01 }, qty: 10 });
  assert.deepEqual(realizedOf(L, 'a', null), { n: 2, cost: { USDT: 3 }, proceeds: { BNB: 0.01, USDT: 5 }, qty: 10 });
  assert.equal(realizedOf(L, 'c', 'main'), null);
});
test('合计视图：已实现盈亏和已卖出部分相加，Element 成交只取一份', () => {
  const a = { contract: NFT, held: 0, realized: { n: 1, cost: { USDT: 1 }, proceeds: { USDT: 2 }, qty: 0 }, el: { fills: 3, bids: 1 }, firstMint: 5 };
  const b = { contract: NFT, held: 2, realized: { n: 2, cost: { USDT: 1 }, proceeds: { USDT: 1 }, qty: 0 }, el: { fills: 3, bids: 2 }, firstMint: 3 };
  const [m] = mergePositions([[a], [b]]);
  assert.equal(m.held, 2); assert.equal(m.realized.n, 3); assert.deepEqual(m.realized.proceeds, { USDT: 3 });
  assert.equal(m.el.fills, 3); assert.equal(m.el.bids, 3); assert.equal(m.firstMint, 3);
});

// ---------- 自动领取 ----------
const pvOk = (balanceChanges, extra = {}) => ({ requestId: 'r', requireConfirmation: false, risks: { addresses: {}, riskDetails: [], riskBehaviors: [] },
  simulationResult: { simulationCode: '000000000', balanceChanges, allowanceChanges: [], authorityChanges: [] }, ...extra });
const got = { owner: ME, tokenType: 'Erc20', change: 100, contractAddress: TOKEN };
test('领取登记：格式检查', () => {
  const c = { project: 'p1', to: REDEEMER, token: TOKEN, data: '0x4e71d92d', notBefore: '2026-11-02T12:00:00+08:00' };
  assert.deepEqual(validateClaim(c), []);
  assert.match(validateClaim({ ...c, data: '0x12' }).join(), /data/);
  assert.match(validateClaim({ ...c, notBefore: 'soon' }).join(), /notBefore/);
  assert.match(validateClaim({ ...c, value: '1000' }).join(), /不付钱/);
});
test('领取预演：零扣款 + 收到登记的代币才通过', () => {
  assert.deepEqual(checkClaimPreview(pvOk([got]), { me: ME, token: TOKEN }), []);
  assert.match(checkClaimPreview(pvOk([]), { me: ME, token: TOKEN }).join(), /没收到/);
  assert.match(checkClaimPreview(pvOk([got, { owner: ME, tokenType: 'Native', change: -1, contractAddress: '0xeeee' }]), { me: ME, token: TOKEN }).join(), /额外扣款/);   // 连 BNB 都不能付
  assert.match(checkClaimPreview({ ...pvOk([got]), simulationResult: { ...pvOk([got]).simulationResult, allowanceChanges: [{}] } }, { me: ME, token: TOKEN }).join(), /授权/);
  assert.match(checkClaimPreview(pvOk([got], { requireConfirmation: true }), { me: ME, token: TOKEN }).join(), /确认/);
  assert.match(checkClaimPreview(pvOk([got], { risks: { addresses: {}, riskDetails: [{}], riskBehaviors: [] } }), { me: ME, token: TOKEN }).join(), /风险/);
});

// ---------- 自动兑换 ----------
const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const tp = a => '0x' + W(a);
const burnTx = ({ value = '0x0', to = REDEEMER, sink = '0x0000000000000000000000000000000000000000', reward = TOKEN } = {}) => ({
  tx: { hash: '0x' + 'a'.repeat(64), from: OTHER, to, value, input: '0xdb006a75' + W(0x20) + W(2) + W(1234) + W(5678) + W(OTHER) },
  rc: { status: '0x1', logs: [
    { address: NFT, topics: [T, tp(OTHER), tp(sink), tp(1234)] },
    { address: NFT, topics: [T, tp(OTHER), tp(sink), tp(5678)] },
    { address: reward, topics: [T, tp(REDEEMER), tp(OTHER)], data: '0x' + W(E18) },
  ] },
});
test('兑换样板：烧卡 + 收到代币 → 认出；付了 BNB / 发给市场 / 收到的是 USDT → 不算', () => {
  const { tx, rc } = burnTx();
  const s = findRedeemSample(tx, rc, NFT);
  assert.deepEqual({ ...s, input: undefined }, { to: REDEEMER, input: undefined, from: OTHER, ids: ['1234', '5678'], token: TOKEN, tx: tx.hash });
  assert.equal(findRedeemSample(burnTx({ value: '0x1' }).tx, rc, NFT), null);   // 公开版只照抄零付费
  assert.equal(findRedeemSample({ ...tx, to: ELEMENT }, rc, NFT, { markets: [ELEMENT] }), null);
  const u = burnTx({ reward: USDT }); assert.equal(findRedeemSample(u.tx, u.rc, NFT), null);
  const x = burnTx({ sink: ME }); assert.equal(findRedeemSample(x.tx, x.rc, NFT), null);   // 卡转给了普通地址：是转账不是兑换
  assert.equal(findRedeemSample(tx, { ...rc, status: '0x0' }, NFT), null);
});
test('兑换照抄：换成我们的卡号和地址；卡号撞上别的参数就不抄', () => {
  const { tx, rc } = burnTx(), s = findRedeemSample(tx, rc, NFT);
  const d = replayCalldata(s, ['11', '22'], ME);
  assert.equal(d, '0xdb006a75' + W(0x20) + W(2) + W(11) + W(22) + W(ME));
  assert.equal(replayCalldata(s, ['11'], ME), null);   // 张数不一样
  const s2 = { ...s, ids: ['2', '5678'], input: '0xdb006a75' + W(0x20) + W(2) + W(2) + W(5678) };   // 卡号 2 和数组长度 2 撞了
  assert.equal(replayCalldata(s2, ['11', '22'], ME), null);
});
test('兑换预演：只交卡、收到代币才通过；付 BNB / 多交卡 / 授权都不行', () => {
  const card = n => ({ owner: ME, tokenType: 'Erc721', change: -n, contractAddress: NFT });
  const o = { me: ME, nft: NFT, token: TOKEN, cards: 2 };
  assert.deepEqual(checkRedeemPreview(pvOk([card(2), got]), o), []);
  assert.match(checkRedeemPreview(pvOk([card(3), got]), o).join(), /3 张卡/);
  assert.match(checkRedeemPreview(pvOk([card(2)]), o).join(), /没收到/);
  assert.match(checkRedeemPreview(pvOk([card(2), got, { owner: ME, tokenType: 'Native', change: -5, contractAddress: '0xeeee' }]), o).join(), /额外扣款/);
  assert.match(checkRedeemPreview(pvOk([card(2), got, { owner: ME, tokenType: 'Erc721', change: -1, contractAddress: OTHER }]), o).join(), /额外扣款/);   // 别的系列的卡
  const pv = pvOk([card(2), got]); pv.simulationResult.authorityChanges = [{}];
  assert.match(checkRedeemPreview(pv, o).join(), /权限/);
});

// ---------- Flap 新盘 ----------
test('Flap：名字清洗，藏代码 / 指令的直接隐藏；推送格式', () => {
  assert.equal(cleanName('Ni<b>ce｜</b>\u200bCoin'), 'NibcebCoin');   // 符号和零宽字符去掉，字母留下
  const seen = { names: {}, creators: {} };
  const m = { market: NFT, rawName: 'Good Dog', rawSym: 'GDOG', creator: ME, quote: 'BNB', buyTax: 1, sellTax: 1, maxWallet: 2 };
  const line = flapLine(m, seen);
  assert.match(line, /^FLAP ca:0x3333.* Good Dog（GDOG）｜底池 BNB · 税 1%\/1% · 单钱包上限 2%｜🟢/);
  assert.match(flapLine(m, seen), /跟风同名/);
  assert.match(flapLine({ ...m, rawName: '<img src=x onerror=import(1)>' }, seen), /已隐藏.*🔴/);
  const msg = parseRadarLine('2026/11/1 12:00:00 ' + line);
  assert.equal(msg.kind, 'FLAP');
  assert.match(msg.text, /🦋 Flap Agent 新盘\n.*Good Dog（GDOG）\n底池 BNB/);
});
test('Element：也认更早的事件写法（bid: 1 / 没有 type）', () => {
  const now = Date.now(), exp = Math.floor(now / 1000) + 99;
  const s = elementSummary([{ p: 0.1, cur: 'BNB', ts: now, id: '1' }, { bid: 1, id: '5', exp, maker: '0xm', nonce: '1', p: 0.2, cur: 'BNB', ts: now }], { '0xm:2': 1 }, [5], now);
  assert.equal(s.fills, 1); assert.deepEqual(s.best, { 5: 0.2 });
  assert.equal(elementSummary([{ bid: 1, id: '5', exp, maker: '0xm', nonce: '1', p: 0.2, cur: 'BNB' }], { '0xm:1': 1 }, [5], now).bids, 0);   // 撤了
});
