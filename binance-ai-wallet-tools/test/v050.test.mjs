// v0.5.0 新功能的纯逻辑：钱包整体盈亏、免费代币登记、掉线补领、免费币止盈、批量探测开盘、免费 NFT 分组、付费 NFT 只出简报。运行：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movesOf, looksLikeExchange, makeNamer, walletPnl, mergePage, klinesToDaily, dayOf, USDT } from '../src/lib/pnl.mjs';
import { tokensFromHistory, tokenId, planFreeTokens } from '../src/lib/freetokens.mjs';
import { missedCandidates, swapAddress, sampleUsable, checkReplayPreview, loginTransition } from '../src/lib/missed.mjs';
import { pickStage, stageName, skipUnopened, unopenedFree, nextProbe, FREE_MIN_USD } from '../src/lib/takeprofit.mjs';
import { parseDexOpen } from '../src/lib/price.mjs';
import { tierOf, isFreeNft, freeCost } from '../src/lib/tiers.mjs';
import { planPaid } from '../src/lib/rules.mjs';

const ME = '0x1111111111111111111111111111111111111111', W2 = '0x2222222222222222222222222222222222222222', EX = '0x3333333333333333333333333333333333333333';
const TOK = '0x4444444444444444444444444444444444444444', NFT = '0x5555555555555555555555555555555555555555', PROJ = '0x6666666666666666666666666666666666666666';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topic = a => '0x' + a.slice(2).padStart(64, '0');
const E18 = 10n ** 18n;
const H = n => '0x' + String(n).repeat(64).slice(0, 64);

// ---------- 钱包整体盈亏 ----------
test('盈亏：从交易和回执里认出和我有关的 BNB / 代币转移', () => {
  const tx = { from: EX, to: ME, value: '0x' + (E18 / 10n).toString(16) };
  const rc = { logs: [
    { address: USDT, topics: [TRANSFER, topic(W2), topic(ME)], data: '0x' + (5n * E18).toString(16).padStart(64, '0') },
    { address: TOK, topics: [TRANSFER, topic(W2), topic(EX)], data: '0x01' },   // 和我无关
    { address: NFT, topics: [TRANSFER, topic(ME), topic(W2), topic('0x07')], data: '0x' },   // NFT（4 个 topic）不算
  ] };
  const mv = movesOf(tx, rc, ME);
  assert.deepEqual(mv.map(m => [m.tok, m.from, m.to]), [['BNB', EX, ME], [USDT, W2, ME]]);
  assert.equal(mv[1].raw, (5n * E18).toString());
  assert.equal(movesOf(null, rc, ME), null);
});
test('盈亏：交易所热钱包 = 没有合约代码、nonce 超过 10 万', () => {
  assert.equal(looksLikeExchange('0x' + (200000).toString(16), '0x'), true);
  assert.equal(looksLikeExchange('0x' + (2201).toString(16), '0x'), false);
  assert.equal(looksLikeExchange('0x' + (200000).toString(16), '0x6080'), false);   // 合约不算
  assert.equal(looksLikeExchange(null, '0x'), false);
});
test('盈亏：项目名先看台账、再看符号；合并规则和合约显示名', () => {
  const nameOf = makeNamer({ projects: [{ id: 'p', name: 'Alpha', contracts: { mint: PROJ } }], merge: [{ match: '^beta', name: 'Beta 全家' }, { match: '(', name: '坏正则被忽略' }], toNames: { [TOK.toUpperCase().replace('0X', '0x')]: '兑换' } });
  assert.equal(nameOf(PROJ, 'XYZ'), 'Alpha');
  assert.equal(nameOf(NFT, 'BETA2'), 'Beta 全家');
  assert.equal(nameOf(TOK, null), '兑换');
  assert.equal(nameOf(W2, null), W2.slice(0, 10));
});

const tx = (h, type, send, receive, fee = 0n, t = '2026-11-01T10:00:00+08:00') => ({ txType: type, txTime: t, status: 'confirmed',
  txHashList: [{ txHash: h, networkFee: { feeValue: String(fee) }, instructions: { send, receive } }] });
const x = (sym, amount, addr = TOK, decimals = 18) => ({ amount: String(amount), tokenInfo: { symbol: sym, contractAddress: addr, decimals } });

test('盈亏：转入本金、项目花费 / 收入、gas、余额 → 净盈亏和核对', () => {
  const history = [
    tx(H(3), 'swap', [x('ALPHA', 1000)], [x('BNB', 0.2)], 10n ** 15n),          // 卖币收 0.2 BNB
    tx(H(2), 'mint', [x('BNB', 0.1)], [x('ALPHA', 1000)], 10n ** 15n),          // 花 0.1 BNB 打
    tx(H(1), 'transfer', [], [x('BNB', 0.5)], 0n),                               // 从交易所转进 0.5 BNB
  ];
  const cp = { [H(1)]: [{ tok: 'BNB', from: EX, to: ME, raw: (E18 / 2n).toString() }] };
  const known = (o, m) => o === EX && m?.to === ME ? '交易所提币' : null;
  const R = walletPnl({ id: 'main', address: ME, history, cp, to: {}, known, nameOf: (a, s) => s || a, pxOn: () => 600, nowPx: 600,
    balance: [{ sym: 'BNB', amt: 0.598, usd: 358.8 }, { sym: 'ALPHA', amt: 0, usd: 0 }], adj: {} });
  assert.equal(R.sum.in, 300);                     // 0.5 × 600
  assert.equal(R.sum.out, 0);
  assert.equal(R.sum.pnl, 58.8);                    // 358.8 − 300
  assert.equal(R.rows.length, 1);
  assert.equal(R.rows[0].name, 'ALPHA');
  assert.equal(R.rows[0].net, 60);                  // +0.2 − 0.1 BNB
  assert.equal(R.rows[0].gas, 1.2);
  assert.equal(R.check.expect, 358.8);              // 300 + 60 − 1.2
  assert.equal(R.check.actual, 358.8);
  assert.equal(R.flows[0].who, '交易所提币');
});
test('盈亏：不认识的对方地址不算本金（按项目算）；加回项计入', () => {
  const history = [tx(H(1), 'transfer', [], [x('BNB', 0.5)])];
  const cp = { [H(1)]: [{ tok: 'BNB', from: W2, to: ME, raw: (E18 / 2n).toString() }] };
  const R = walletPnl({ id: 'w', address: ME, history, cp, known: () => null, nameOf: (a, s) => s || 'x', pxOn: () => 600, nowPx: 600,
    balance: [{ sym: 'BNB', amt: 0.5, usd: 300 }], adj: { 空投: [{ usd: 12, note: '转出后卖掉' }, { bnb: 0.01 }] } });
  assert.equal(R.sum.in, 0);
  assert.equal(R.sum.added, 18);
  assert.equal(R.sum.pnl, 318);
  assert.deepEqual(R.rows.find(r => r.name === '空投').notes, ['转出后卖掉']);
});
test('盈亏：增量翻页——接上旧缓存 / 拉到底才算完整，pending 跳过', () => {
  const seen = new Set([H(9)]), fresh = [];
  const t1 = { status: 'confirmed', txHashList: [{ txHash: H(1) }] }, tp = { status: 'pending', txHashList: [{ txHash: H(2) }] }, old = { status: 'confirmed', txHashList: [{ txHash: H(9) }] };
  assert.deepEqual(mergePage({ transactions: [t1, tp], hasMore: true, nextCursor: 'c1' }, seen, fresh), { stop: false, done: false, cursor: 'c1' });
  assert.deepEqual(mergePage({ transactions: [old, t1], hasMore: true, nextCursor: 'c2' }, seen, fresh), { stop: true, done: true });
  assert.equal(fresh.length, 1);
  assert.deepEqual(mergePage({ transactions: [], hasMore: false }, seen, []), { stop: true, done: true });
});
test('盈亏：日 K 线按北京时间的日期取收盘价', () => {
  const P = klinesToDaily([[Date.parse('2026-11-01T00:00:00Z'), '0', '0', '0', '612.5'], ['bad']]);
  assert.deepEqual(P, { '2026-11-01': 612.5 });
  assert.equal(dayOf('2026-11-01T23:30:00+08:00'), '2026-11-01');
});

// ---------- 免费代币登记 ----------
test('免费代币：只认自己发起、没花 BNB/USDT 的到账；空投、买卖、NFT 不算；花过钱的标出来', () => {
  const H2 = [
    tx(H(1), 'mint', [], [x('FREE', 100, TOK)]),
    tx(H(2), 'transfer', [], [x('AIRDROP', 1, W2)]),
    tx(H(3), 'swap', [x('BNB', 1)], [x('SWAPPED', 1, EX)]),
    tx(H(4), 'mint', [], [x('NFT', 1, NFT, 0)]),
    tx(H(5), 'contract_call', [x('BNB', 0.01)], [x('PAID', 5, PROJ)]),
  ];
  const got = tokensFromHistory(H2);
  assert.deepEqual([...got.keys()], [TOK, PROJ]);
  assert.equal(got.get(TOK).free, true);
  assert.equal(got.get(PROJ).free, false);
});
test('免费代币：id 不重复；链上已经没有 / 不到 1 枚 / 是 NFT 的不登记', async () => {
  assert.equal(tokenId('Moon Cat!', TOK), 'mooncat-4444');
  assert.equal(tokenId('Moon Cat!', TOK, new Set(['mooncat-4444'])), 'mooncat-4444x');
  const got = new Map([[TOK, { sym: 'A', free: true }], [EX, { sym: 'DUST', free: true }], [NFT, { sym: 'N', free: true }], [PROJ, { sym: 'P', free: false }], [W2, { sym: 'HAVE', free: true }]]);
  const chain = { [TOK]: { raw: 5n * E18, decimals: 18 }, [EX]: { raw: E18 / 2n, decimals: 18 }, [NFT]: { raw: 1n, decimals: 0, nft: true }, [PROJ]: { raw: E18, decimals: 18 } };
  const r = await planFreeTokens(got, { have: new Set([W2]), onchain: async a => chain[a] });
  assert.deepEqual(r.add, [{ contract: TOK, sym: 'A' }]);
  assert.deepEqual(r.paid, [{ contract: PROJ, sym: 'P' }]);
  const r2 = await planFreeTokens(got, { have: new Set([W2]), skip: new Set([TOK]), onchain: async a => chain[a] });
  assert.equal(r2.add.length, 0);
});

// ---------- 掉线补领 ----------
const WALLETS = [{ id: 'main', address: ME, main: true }, { id: 'w2', address: W2 }];
test('补领：候选 = 掉线后别的钱包免费领过、这个钱包没领过的项目；付过钱的项目不碰', () => {
  const sp = [
    { ts: '2026-11-02T00:00:00Z', pid: 'a', contract: PROJ, paid: 0, bnb: 0, tx: H(1) },                    // 主钱包免费领（没 wallet 字段）
    { ts: '2026-11-02T01:00:00Z', pid: 'a', contract: PROJ, paid: 0, bnb: 0, tx: H(2), wallet: 'main' },    // 同项目第二笔，只取第一笔
    { ts: '2026-11-02T00:00:00Z', pid: 'b', contract: PROJ, paid: 1, bnb: 0.01, tx: H(3) },                  // 付费
    { ts: '2026-11-02T00:00:00Z', pid: 'c', contract: PROJ, paid: 0, bnb: 0, tx: H(4) },                     // w2 已领过
    { ts: '2026-11-02T00:00:00Z', pid: 'c', contract: PROJ, paid: 0, bnb: 0, tx: H(5), wallet: 'w2' },
    { ts: '2026-10-01T00:00:00Z', pid: 'd', contract: PROJ, paid: 0, bnb: 0, tx: H(6) },                     // 太早
    { ts: '2026-11-02T00:00:00Z', pid: 'e', contract: PROJ, paid: 0, bnb: 0, tx: 'bad' },                    // 没交易哈希
    { ts: '2026-11-02T00:00:00Z', pid: 'f', contract: PROJ, paid: 0, bnb: 0, tx: H(7) },                     // 已补过
  ];
  const c = missedCandidates(sp, { wallets: WALLETS, id: 'w2', since: '2026-11-01', done: { f: '0xabc' } });
  assert.deepEqual(c, [{ pid: 'a', contract: PROJ, tx: H(1), from: ME }]);
});
test('补领：调用数据里只换对齐的地址参数', () => {
  const sel = '0x12345678', w = a => a.slice(2).padStart(64, '0');
  const input = sel + w(ME) + '0'.repeat(63) + '5' + w(ME);
  assert.equal(swapAddress(input, ME, W2), sel + w(W2) + '0'.repeat(63) + '5' + w(W2));
  assert.equal(swapAddress(sel + '00' + ME.slice(2) + '0'.repeat(22), ME, W2), sel + '00' + ME.slice(2) + '0'.repeat(22));   // 不对齐：不动
  assert.equal(swapAddress('0x1234', ME, W2), null);
  assert.equal(swapAddress(input, 'bad', W2), null);
});
test('补领：样板必须成功、发给合约、不付 BNB', () => {
  assert.equal(sampleUsable({ to: PROJ, value: '0x0' }, { status: '0x1' }), null);
  assert.match(sampleUsable({ to: PROJ, value: '0x1' }, { status: '0x1' }), /付了 BNB/);
  assert.match(sampleUsable({ to: PROJ, value: '0x0' }, { status: '0x0' }), /失败/);
  assert.match(sampleUsable({ to: null, value: '0x0' }, { status: '0x1' }), /创建合约/);
  assert.match(sampleUsable(null, null), /读不到/);
});
const pvOk = (balanceChanges, extra = {}) => ({ requestId: 'r', requireConfirmation: false, risks: { addresses: {}, riskDetails: [], riskBehaviors: [] },
  simulationResult: { simulationCode: '000000000', balanceChanges, allowanceChanges: [], authorityChanges: [] }, ...extra });
test('补领：预演连 BNB 都不能扣、不能有授权 / 风险 / 二次确认，而且必须收到东西', () => {
  const got = { owner: ME, tokenType: 'ERC721', change: 1, contractAddress: NFT };
  assert.deepEqual(checkReplayPreview(pvOk([got]), { me: ME }), []);
  assert.match(checkReplayPreview(pvOk([got, { owner: ME, tokenType: 'Native', change: -1, contractAddress: '0xeeee' }]), { me: ME }).join(), /额外扣款/);
  assert.match(checkReplayPreview(pvOk([]), { me: ME }).join(), /什么都没收到/);
  assert.match(checkReplayPreview(pvOk([got], { requireConfirmation: true }), { me: ME }).join(), /二次确认/);
  const pv = pvOk([got]); pv.simulationResult.allowanceChanges = [{}];
  assert.match(checkReplayPreview(pv, { me: ME }).join(), /授权/);
});
test('补领：登录状态从掉线变回在线才补，起点是掉线时间往前 2 小时', () => {
  const t0 = Date.parse('2026-11-05T00:00:00Z');
  assert.deepEqual(loginTransition(undefined, true, t0), { next: { up: true }, backfillFrom: null });   // 第一次看到在线：不补
  const down = loginTransition({ up: true }, false, t0);
  assert.equal(down.backfillFrom, null); assert.equal(down.next.up, false);
  const still = loginTransition(down.next, false, t0 + 3600e3);
  assert.equal(still.next.downAt, down.next.downAt);   // 一直掉线：时间不往后挪
  const back = loginTransition(still.next, true, t0 + 7200e3);
  assert.equal(back.backfillFrom, t0 - 2 * 3600e3);
  assert.deepEqual(back.next, { up: true });
});

// ---------- 免费币止盈 ----------
const q = (price, raw = 1000n * E18, mult = 1) => ({ mult, price, raw, decimals: 18 });
test('免费币止盈：开盘先卖一半；一半不值 0.3 美元先不卖', () => {
  const t = { free: true };
  const p = pickStage(t, { done: {} }, q(0.001));   // 500 枚 × 0.001 = $0.5
  assert.equal(p.stage, 'open'); assert.equal(p.amount, 500n * E18); assert.equal(p.name, stageName('open'));
  assert.equal(pickStage(t, { done: {} }, q(0.0005)), null);   // 一半 $0.25
  assert.equal(pickStage(t, { done: {} }, q(0.0005), { freeMinUsd: 0.1 }).stage, 'open');
  assert.equal(FREE_MIN_USD, 0.3);
});
test('免费币止盈：开盘之后按开盘价走阶梯，不走「3 倍回本」', () => {
  const t = { free: true }, s = { done: { open: 'x' }, costUsd: 1 };
  assert.equal(pickStage(t, s, q(0.01, 1000n * E18, 5)), null);
  assert.equal(pickStage(t, s, q(0.01, 1000n * E18, 10)).stage, 'tp10');
  assert.equal(pickStage(t, { done: { open: 'x', tp10: 'y' }, costUsd: 1 }, q(0.01, 1000n * E18, 2.5)).stage, 'back3');
  assert.equal(pickStage({ free: true, hold: true }, { done: {} }, q(1)), null);   // hold 优先
});
test('没开盘的免费币：批量查不到池子、还没到补查时间就跳过', () => {
  const t = { free: true, contract: TOK }, now = 1e12, open = new Set();
  assert.equal(unopenedFree(t, {}), true);
  assert.equal(unopenedFree(t, { costUsd: 1 }), false);
  assert.equal(skipUnopened(t, { origAmount: 1, probeAt: now + 1 }, open, now), true);
  assert.equal(skipUnopened(t, { origAmount: 1, probeAt: now - 1 }, open, now), false);   // 到时间：补查 GeckoTerminal
  assert.equal(skipUnopened(t, { origAmount: 1, probeAt: now + 1 }, new Set([TOK]), now), false);   // 批量查到了
  assert.equal(skipUnopened(t, { origAmount: 1, probeAt: now + 1 }, null, now), false);   // 批量查失败：退回逐个查
  assert.equal(skipUnopened(t, { probeAt: now + 1 }, open, now), false);   // 第一次见：要读余额
  assert.equal(skipUnopened({ contract: TOK }, { origAmount: 1, probeAt: now + 1 }, open, now), false);   // 不是免费币
  assert.equal(nextProbe(0, 0), 45 * 60_000); assert.equal(nextProbe(0, 1), 75 * 60_000);
});
test('批量探测：DexScreener 结果里只认 BSC、有价格、在这批里的代币（base / quote 都算）', () => {
  const j = { pairs: [
    { chainId: 'bsc', priceUsd: '0.1', baseToken: { address: TOK.toUpperCase().replace('0X', '0x') }, quoteToken: { address: USDT } },
    { chainId: 'bsc', priceUsd: '1', baseToken: { address: W2 }, quoteToken: { address: EX } },
    { chainId: 'ethereum', priceUsd: '1', baseToken: { address: NFT } },
    { chainId: 'bsc', priceUsd: '0', baseToken: { address: PROJ } },
  ] };
  assert.deepEqual([...parseDexOpen(j, [TOK, EX, NFT, PROJ])].sort(), [EX, TOK].sort());
  assert.equal(parseDexOpen(null, [TOK]).size, 0);
});

// ---------- 免费 NFT 分组 ----------
test('分组：没花钱、还拿着、没卖过的 NFT 归「免费 NFT」；没记成本、代币、有报价的不算', () => {
  const now = Date.now(), old = now - 5 * 86400e3;
  assert.equal(freeCost({ BNB: 0 }), true); assert.equal(freeCost({ BNB: 0.01 }), false); assert.equal(freeCost(null), false); assert.equal(freeCost({}), false);
  assert.equal(tierOf({ held: 1, cost: { BNB: 0 }, marketType: 'none', firstMint: old }, now), 'free');
  assert.equal(tierOf({ held: 1, cost: { BNB: 0 }, marketType: 'none', firstMint: now }, now), 'free');
  assert.equal(tierOf({ held: 1, cost: { BNB: 0 }, floor: 0.01 }, now), 'open');
  assert.equal(tierOf({ held: 1, cost: { BNB: 0.01 }, marketType: 'none', firstMint: old }, now), 'idle');
  assert.equal(tierOf({ held: 1, marketType: 'none', firstMint: old }, now), 'idle');
  assert.equal(tierOf({ held: 0, cost: { BNB: 0 } }, now), 'exit');
  assert.equal(isFreeNft({ kind: 'token', held: 1, cost: { BNB: 0 } }), false);
  assert.equal(isFreeNft({ held: 1, cost: { BNB: 0 }, realized: { n: 1 } }), false);
});

// ---------- 付费 NFT ----------
test('付费 NFT：默认不付费（只拿免费张），原因写清楚', async () => {
  const S = { allowAutoPaid: true, maxUnitUsd: 3, maxPaidPerProject: 10, maxDailyBnb: null, gasLikeBnb: 0.0005 };
  const base = { spending: S, usdPerBnb: 600, verified: 'exact_match', official: true, freeOnly: false, clone: null, scam: null, spentToday: 0, paidSoFar: 0 };
  const r = await planPaid({ free: 1, paid: 2, totalOf: async () => 10n ** 15n }, { ...base, paidNft: true });
  assert.equal(r.paid, 0); assert.match(r.notes.join(), /付费 NFT/);
  const ok = await planPaid({ free: 1, paid: 2, totalOf: async () => 10n ** 15n }, { ...base, paidNft: false });
  assert.equal(ok.paid, 2);
});
