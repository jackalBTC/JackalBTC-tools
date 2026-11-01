// v0.4.1 新功能的纯逻辑：付费项目防骗检查、代币取价、授权巡检、成本自检。运行：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THRESHOLD_RANGES, makeThresholds, validThresholds, mintUnits, senderStats, judgeMinting, isDrained, minimalProxyTarget, codeHash,
  sameCodeWithin, recentCandidateCas, cidOk, parseTokenUri, imageOf, imageKey, noteImage, verdictOf, gatewaysFor, httpOutcome, combineOutcomes, IPFS_GATEWAYS } from '../src/lib/scam.mjs';
import { parseDexPairs, parseGtPools, pickBest, capValue } from '../src/lib/price.mjs';
import { approvalKey, isUnlimited, isRisky, diffApprovals, approvalNews } from '../src/lib/approvals.mjs';
import { paidByWallet, hasCost, auditWatch } from '../src/lib/costaudit.mjs';
import { usableBnbUsd } from '../src/lib/takeprofit.mjs';
import { planPaid } from '../src/lib/rules.mjs';
import { mergePositions } from '../src/server/merge.mjs';

const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222';
const NFT = '0x3333333333333333333333333333333333333333', TOKEN = '0x4444444444444444444444444444444444444444';
const POOL = '0x5555555555555555555555555555555555555555', C2 = '0x6666666666666666666666666666666666666666', C3 = '0x7777777777777777777777777777777777777777';
const T = { paidProgress: 65, minSenders: 25, minSendersDrained: 45 };
const topic = a => '0x' + a.slice(2).padStart(64, '0');
const mintLog = (tx, to, id = 1) => ({ transactionHash: tx, topics: ['0xddf2', '0x' + '0'.repeat(64), topic(to), '0x' + id.toString(16).padStart(64, '0')], data: '0x' });

// ---------- 本机门槛 ----------
test('门槛：随机值落在范围内，最小 / 最大都取得到', () => {
  const lo = makeThresholds(() => 0), hi = makeThresholds(() => 0.999999);
  for (const [k, [a, b]] of Object.entries(THRESHOLD_RANGES)) { assert.equal(lo[k], a); assert.equal(hi[k], b); }
  assert.ok(validThresholds(lo) && validThresholds(hi));
  assert.ok(lo.created);
});
test('门槛：文件被改坏（超出范围 / 缺字段 / 不是整数）判为无效，会重新生成', () => {
  assert.equal(validThresholds(null), false);
  assert.equal(validThresholds({ ...T, paidProgress: 50 }), false);
  assert.equal(validThresholds({ paidProgress: 65, minSenders: 25 }), false);
  assert.equal(validThresholds({ ...T, minSenders: 25.5 }), false);
  assert.equal(validThresholds(T), true);
});

// ---------- 铸造人数 ----------
test('人数按交易发起人算：一个地址代铸给 30 个地址，只算 1 个人，还是诱饵盘', () => {
  const logs = Array.from({ length: 30 }, (_, i) => mintLog('0xt' + i, '0x' + (i + 10).toString(16).padStart(40, '0'), i));
  const froms = new Map(logs.map(l => [l.transactionHash, A]));
  const st = senderStats(logs, froms, true);
  assert.equal(st.recipients, 30);
  assert.equal(st.senders, 1);
  const j = judgeMinting(st, T);
  assert.ok(j.block.some(x => x.includes('只有 1 个钱包')));
  assert.ok(j.block.some(x => x.includes('诱饵盘')));
});
test('人数够、没人占大头：不拦；钱不在合约里门槛更高', () => {
  const logs = [], froms = new Map();
  for (let i = 0; i < 30; i++) { const s = '0x' + (i + 100).toString(16).padStart(40, '0'); logs.push(mintLog('0xh' + i, s, i)); froms.set('0xh' + i, s); }
  const st = senderStats(logs, froms, true);
  assert.equal(st.senders, 30);
  assert.deepEqual(judgeMinting(st, T).block, []);
  const d = judgeMinting(st, T, { drained: true });
  assert.ok(d.block[0].includes('要求 ≥45'));
  assert.ok(d.warn.some(x => x.includes('几乎没有 BNB')));
});
test('单个地址铸了 >30%：拦（诱饵盘）', () => {
  const logs = [], froms = new Map();
  for (let i = 0; i < 30; i++) { const s = '0x' + (i + 100).toString(16).padStart(40, '0'); logs.push(mintLog('0xh' + i, s, i)); froms.set('0xh' + i, s); }
  for (let i = 0; i < 20; i++) { logs.push(mintLog('0xb' + i, B, 100 + i)); froms.set('0xb' + i, B); }
  const j = judgeMinting(senderStats(logs, froms, true), T);
  assert.equal(j.block.length, 1);
  assert.ok(j.block[0].includes(B) && j.block[0].includes('40%'));
});
test('代币铸造按数量算份数；查不到发起人的日志不计入', () => {
  const l = { transactionHash: '0x1', topics: ['0xddf2', '0x0', topic(A)], data: '0x' + (5n * 10n ** 18n).toString(16).padStart(64, '0') };
  assert.equal(mintUnits(l, false), 5);
  const st = senderStats([l, { ...l, transactionHash: '0x2' }], new Map([['0x1', A]]), false);
  assert.equal(st.total, 5); assert.equal(st.senders, 1);
  assert.equal(isDrained(0.005, 1), true); assert.equal(isDrained(0.5, 0), false);
});

// ---------- 合约代码 ----------
test('EIP-1167 最小代理：认出背后的实现合约；普通代码返回 null', () => {
  assert.equal(minimalProxyTarget('0x363d3d373d3d3d363d73' + B.slice(2) + '5af43d82803e903d91602b57fd5bf3'), B);
  assert.equal(minimalProxyTarget('0x6080604052'), null);
  assert.equal(codeHash('0x'), null);
  assert.equal(codeHash('0xABCD'), codeHash('0xabcd'));
});
test('同款合约：24 小时内同一份代码 ≥3 个才算；过期的不算', () => {
  const now = Date.parse('2026-11-01T12:00:00Z'), iso = h => new Date(now - h * 3600_000).toISOString();
  const cache = { [NFT]: { code: 'x', seen: iso(0) }, [C2]: { code: 'x', seen: iso(2) }, [C3]: { code: 'x', seen: iso(30) }, [A]: { code: 'y', seen: iso(1) } };
  assert.deepEqual(sameCodeWithin(cache, NFT, now).sort(), [NFT, C2].sort());
  cache[C3].seen = iso(5);
  assert.equal(sameCodeWithin(cache, NFT, now).length, 3);
  assert.deepEqual(sameCodeWithin({ [NFT]: { code: null } }, NFT, now), []);
});
test('雷达候选：只取 24 小时内的合约，记最早出现时间，坏行跳过', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const lines = [JSON.stringify({ ts: '2026-10-30T00:00:00Z', cas: [C3] }), 'not json',
    JSON.stringify({ ts: '2026-11-01T01:00:00Z', cas: [NFT.toUpperCase().replace('0X', '0x'), 'bad'] }), JSON.stringify({ ts: '2026-11-01T02:00:00Z', cas: [NFT] })];
  const m = recentCandidateCas(lines, now);
  assert.deepEqual([...m.keys()], [NFT]);
  assert.equal(m.get(NFT), '2026-11-01T01:00:00Z');
});

// ---------- NFT 图片 ----------
const CID = 'Qm' + 'a'.repeat(44);
test('tokenURI：空的、假 CID、乱写的拦；内嵌 JSON 直接读；正常链接走网关', () => {
  assert.ok(parseTokenUri('').block.includes('没有 tokenURI'));
  assert.ok(parseTokenUri('ipfs://notacid/1.json').block.includes('假的 IPFS'));
  assert.ok(parseTokenUri('hello').block.includes('不是正常链接'));
  assert.deepEqual(parseTokenUri('data:application/json;base64,' + Buffer.from('{"image":"x"}').toString('base64')).meta, { image: 'x' });
  assert.deepEqual(parseTokenUri('data:application/json,' + encodeURIComponent('{"a":1}')).meta, { a: 1 });
  assert.equal(parseTokenUri(`ipfs://${CID}/1.json`).urls[0], `https://ipfs.io/ipfs/${CID}/1.json`);
  assert.deepEqual(parseTokenUri('https://example.com/1.json').urls, ['https://example.com/1.json']);
  assert.equal(cidOk('https://example.com/a.png'), true);
});
test('图片：没图、假链接拦；链上 SVG 不用下载；同一张图在别的合约用过要报出来', () => {
  assert.ok(imageOf({}).block.includes('没有图片'));
  assert.ok(imageOf({ image: 'ipfs://xyz' }).block.includes('图片链接是假的'));
  assert.equal(imageOf({ image: 'data:image/svg+xml;base64,AAAA' }).onchain, true);
  assert.equal(imageOf({ image: `ipfs://ipfs/${CID}` }).urls[0], `https://ipfs.io/ipfs/${CID}`);
  assert.equal(imageKey(`ipfs://${CID}?x=1`), `https://ipfs.io/ipfs/${CID.toLowerCase()}`);
  assert.ok(imageKey('<svg></svg>').startsWith('svg:'));
  const idx = {};
  assert.deepEqual(noteImage(idx, 'k', NFT), []);
  assert.deepEqual(noteImage(idx, 'k', NFT), []);   // 同一个合约再看一次不算
  assert.deepEqual(noteImage(idx, 'k', C2), [NFT]);
  assert.equal(verdictOf({ block: [], warn: ['x'] }), '可打，但有提醒');
  assert.equal(verdictOf({ block: ['x'], warn: [] }), '拦');
});

test('IPFS 网关：ipfs:// 依次试 4 个；写成网关 https 链接的先试它自己再试别的；ar:// 走 arweave', () => {
  assert.deepEqual(gatewaysFor(`ipfs://${CID}/a.png`), IPFS_GATEWAYS.map(g => `${g}${CID}/a.png`));
  const g = gatewaysFor(`https://ipfs.io/ipfs/${CID}`);
  assert.equal(g[0], `https://ipfs.io/ipfs/${CID}`); assert.equal(g.length, 4);
  assert.deepEqual(gatewaysFor('ar://abc'), ['https://arweave.net/abc']);
});
test('网关结果：429 / 5xx / 超时 / 网络错误只算暂时读不到；全部明确 404 才算打不开；有一个通就算通', () => {
  assert.equal(httpOutcome(200), 'ok');
  assert.equal(httpOutcome(429), 'unavailable');
  assert.equal(httpOutcome(503), 'unavailable');
  assert.equal(httpOutcome(408), 'unavailable');
  assert.equal(httpOutcome(0), 'unavailable');
  assert.equal(httpOutcome(404), 'bad');
  assert.equal(httpOutcome(400), 'bad');
  assert.equal(combineOutcomes(['bad', 'bad', 'bad', 'bad']), 'bad');
  assert.equal(combineOutcomes(['unavailable', 'bad', 'bad', 'bad']), 'unavailable');
  assert.equal(combineOutcomes(['unavailable', 'ok']), 'ok');
  assert.equal(combineOutcomes([]), 'unavailable');
});

// ---------- 防骗检查接进花钱规则 ----------
const SP = { allowAutoPaid: true, maxUnitUsd: 3, maxPaidPerProject: 10, maxDailyBnb: null, gasLikeBnb: 0.0005 };
test('防骗检查拦下：付费部分归零，只拿免费张', async () => {
  const r = await planPaid({ free: 1, paid: 2, totalOf: async () => 10n ** 15n }, { spending: SP, usdPerBnb: 600, verified: 'exact_match', official: true, scam: '单个地址铸了 60%', spentToday: 0, paidSoFar: 0 });
  assert.equal(r.paid, 0);
  assert.ok(r.notes.some(n => n.includes('防骗检查不通过')));
  const ok = await planPaid({ free: 1, paid: 2, totalOf: async () => 10n ** 15n }, { spending: SP, usdPerBnb: 600, verified: 'exact_match', official: true, scam: null, spentToday: 0, paidSoFar: 0 });
  assert.equal(ok.paid, 2);
});

// ---------- 代币取价 ----------
test('DexScreener：只要 BSC、价格 > 0 的池子；网址不对的不要', () => {
  const p = parseDexPairs({ pairs: [{ chainId: 'bsc', priceUsd: '0.5', liquidity: { usd: 1000 }, dexId: 'pancakeswap', pairAddress: POOL, url: 'https://dexscreener.com/bsc/x' },
    { chainId: 'eth', priceUsd: '9', liquidity: { usd: 1e9 } }, { chainId: 'bsc', priceUsd: '0', liquidity: { usd: 5 } }, { chainId: 'bsc', priceUsd: '1', url: 'https://evil.example/x' }] });
  assert.equal(p.length, 2);
  assert.equal(p[0].pool, POOL); assert.equal(p[0].src, 'dexscreener');
  assert.equal(p[1].url, null); assert.equal(p[1].liquidity, 0);
});
test('GeckoTerminal：代币在 base 取 base 价，在 quote 取 quote 价，都不是的丢掉', () => {
  const pool = (base, quote, extra = {}) => ({ attributes: { address: POOL, base_token_price_usd: '2', quote_token_price_usd: '0.01', reserve_in_usd: '5000', ...extra }, relationships: { base_token: { data: { id: 'bsc_' + base } }, quote_token: { data: { id: 'bsc_' + quote } }, dex: { data: { id: 'pancakeswap-v4' } } } });
  const p = parseGtPools({ data: [pool(TOKEN, A), pool(A, TOKEN), pool(A, B), pool(TOKEN, A, { address: 'bad' })] }, TOKEN.toUpperCase().replace('0X', '0x'));
  assert.equal(p.length, 3);
  assert.equal(p[0].price, 2); assert.equal(p[1].price, 0.01);
  assert.equal(p[0].url, `https://www.geckoterminal.com/bsc/pools/${POOL}`);
  assert.equal(p[2].pool, null); assert.equal(p[2].url, null);
  assert.equal(parseGtPools({ data: [pool(TOKEN, A, { address: '0x' + 'ab'.repeat(32) })] }, TOKEN)[0].pool, '0x' + 'ab'.repeat(32));   // v4 池子 id 是 32 字节
  assert.equal(p[0].liquidity, 5000); assert.equal(p[0].dex, 'pancakeswap-v4');
});
test('取流动性最大的池子（不是最高价）；估值最多按池子流动性的 30%', () => {
  const best = pickBest([{ price: 9, liquidity: 10 }, { price: 1, liquidity: 50000 }, { price: 0, liquidity: 1e9 }]);
  assert.equal(best.price, 1);
  assert.equal(pickBest([]), null);
  assert.equal(capValue(100, { price: 1, liquidity: 50000 }), 100);
  assert.equal(capValue(100000, { price: 1, liquidity: 50000 }), 15000);
  assert.equal(capValue(100, { price: 1, liquidity: 0 }), 100);   // 流动性未知不封顶
  assert.equal(capValue(100, null), 0);
});
test('看板合计：几个钱包的同一个代币合起来后重新封顶', () => {
  const p = w => ({ kind: 'token', contract: TOKEN, held: 60000, floor: 1, liquidity: 100000, value: 30000, cost: { USDT: 1 } });
  const [m] = mergePositions([[p()], [p()]]);
  assert.equal(m.held, 120000);
  assert.equal(m.value, 30000);
  assert.equal(m.valueCapped, true);
});

// ---------- 授权巡检 ----------
test('授权：无限额（unlimited 或 ≥2^200）、风险标记', () => {
  assert.equal(isUnlimited('unlimited'), true);
  assert.equal(isUnlimited('Unlimited'), true);
  assert.equal(isUnlimited((2n ** 255n).toString()), true);
  assert.equal(isUnlimited('1000000000000000000'), false);
  assert.equal(isUnlimited('abc'), false);
  assert.equal(isRisky({ riskyLevel: 2 }), true);
  assert.equal(isRisky({ noInteractive: true }), true);
  assert.equal(isRisky({ riskyLevel: 0 }), false);
});
test('授权：第一次只记底；之后只报新出现的；没有 id 用代币 + 对象 + 类型', () => {
  const a1 = { id: 'a1', amount: '1' }, a2 = { id: 'a2', amount: 'unlimited' }, a3 = { tokenContract: TOKEN, spender: B, type: 'approve' };
  const f = diffApprovals(undefined, [a1]);
  assert.equal(f.first, true); assert.deepEqual(f.fresh, []); assert.deepEqual(f.keys, ['a1']);
  const d = diffApprovals(f.keys, [a1, a2, a3]);
  assert.equal(d.first, false); assert.deepEqual(d.fresh, [a2, a3]);
  assert.equal(approvalKey(a3), `${TOKEN}:${B}:approve`);
  assert.deepEqual(diffApprovals(d.keys, [a1]).fresh, []);   // 撤掉的不报
});
test('授权：无限额 / 有风险是「重要」，其余「注意」；名字里的怪字符被清掉', () => {
  const n = approvalNews({ tokenSymbol: 'USDT', tokenContract: TOKEN, spender: B, spenderName: '<b>X</b>', amount: 'unlimited' }, '主钱包');
  assert.equal(n.level, '重要');
  assert.ok(n.summary.includes('额度 无限'));
  assert.ok(!n.summary.includes('<'));
  assert.ok(n.title.includes('主钱包 新增授权'));
  assert.equal(approvalNews({ tokenContract: TOKEN, spender: B, amount: '5' }, 'w2').level, '注意');
  assert.equal(approvalNews({ tokenContract: TOKEN, spender: B, amount: '5', riskyLevel: 1 }, 'w2').level, '重要');
});

// ---------- 成本 ----------
test('BNB 价格：读不到用上一次的，都没有返回 null（这一轮不动）', () => {
  assert.equal(usableBnbUsd(600, 500), 600);
  assert.equal(usableBnbUsd(NaN, 500), 500);
  assert.equal(usableBnbUsd(0, 500), 500);
  assert.equal(usableBnbUsd(NaN, undefined), null);
  assert.equal(usableBnbUsd(undefined, NaN), null);
});
test('成本自检：按钱包 + 合约合计花费账；只补空 / 0 的成本，已有成本不动', () => {
  const lines = [JSON.stringify({ contract: NFT, bnb: 0.01 }), JSON.stringify({ contract: NFT.toUpperCase().replace('0X', '0x'), bnb: 0.005 }),
    JSON.stringify({ contract: NFT, bnb: 0.2, wallet: 'w2' }), JSON.stringify({ contract: C2, bnb: 0 }), 'broken', JSON.stringify({ contract: C3, bnb: 0.1 })];
  const paid = paidByWallet(lines, 'main');
  assert.equal(paid.get(`main:${NFT}`), 0.015);
  assert.equal(paid.get(`w2:${NFT}`), 0.2);
  assert.equal(paid.has(`main:${C2}`), false);
  const watch = { collections: [{ id: 'demo', name: 'Demo', contract: NFT, cost: { BNB: 0 } }, { id: 'kept', contract: C3, cost: { USDT: 3 } }, { id: 'free', contract: C2 }] };
  const fixed = auditWatch(watch, 'main', paid);
  assert.deepEqual(fixed, [{ id: 'demo', name: 'Demo', bnb: 0.015 }]);
  assert.deepEqual(watch.collections[0].cost, { BNB: 0.015 });
  assert.deepEqual(watch.collections[1].cost, { USDT: 3 });
  assert.equal(watch.collections[2].cost, undefined);
  assert.deepEqual(auditWatch(watch, 'main', paid), []);   // 补过一次就不再补
  assert.equal(hasCost({ BNB: 0, USDT: 0 }), false);
  assert.equal(hasCost({ BNB: NaN }), false);
});
