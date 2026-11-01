// v0.4.2 付费按份铸币（share-mint）的纯逻辑：进度读取与合理性、预算、源码审查记录、五道关口、通行证、配置校验。运行：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uintOf, pickProgress, computeProgress, spentUsdFor, planShare, checkReview, evaluateGates, gateValid, validateShareMint,
  SOLD_FALLBACK, FN_RE, GATE_TTL_MS } from '../src/lib/sharemint.mjs';

const MINT = '0x1111111111111111111111111111111111111111', TOKEN = '0x2222222222222222222222222222222222222222', OTHER = '0x3333333333333333333333333333333333333333';
const hex = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const NOW = Date.parse('2026-11-01T12:00:00Z');
const REVIEW = { fundsStay: true, noWithdraw: true, mintLocked: true, lpBurned: true, by: 'ai', at: '2026-11-01T11:00:00Z', notes: '读过源码' };
const E18 = 10n ** 18n;

// ---------- 进度 ----------
test('uintOf：只认恰好 32 字节', () => {
  assert.equal(uintOf(hex(5)), 5n);
  assert.equal(uintOf('0x'), null);
  assert.equal(uintOf(hex(1) + '00'.repeat(32)), null);   // 两个返回值
  assert.equal(uintOf(null), null);
});
test('computeProgress：百分比两位小数；>100%、上限 0 → 不通过', () => {
  assert.deepEqual(computeProgress(650n, 1000n), { ok: true, sold: 650n, cap: 1000n, pct: 65 });
  assert.equal(computeProgress(2n, 3n).pct, 66.66);
  assert.equal(computeProgress(0n, 10n).pct, 0);
  assert.equal(computeProgress(1000n, 1000n).pct, 100);
  assert.equal(computeProgress(1001n, 1000n).ok, false);
  assert.match(computeProgress(1001n, 1000n).reason, />100%/);
  assert.equal(computeProgress(1n, 0n).ok, false);
  assert.equal(computeProgress(1, 10n).ok, false);
});
test('pickProgress：常见函数一致 → 通过', () => {
  const r = pickProgress({ sold: [{ sig: 'totalMinted()', value: 700n }, { sig: 'sold()', value: 700n }, { sig: 'minted()', value: null }],
    cap: [{ sig: 'maxShares()', value: 1000n }, { sig: 'cap()', value: null }] });
  assert.equal(r.ok, true); assert.equal(r.pct, 70); assert.equal(r.soldSig, 'totalMinted()=sold()'); assert.equal(r.capSig, 'maxShares()');
});
test('pickProgress：「已铸」读数不一致 / 上限读数不一致 → 不通过', () => {
  assert.match(pickProgress({ sold: [{ sig: 'totalMinted()', value: 700n }, { sig: 'sold()', value: 5n }], cap: [{ sig: 'maxShares()', value: 1000n }] }).reason, /不一致/);
  assert.match(pickProgress({ sold: [{ sig: 'totalMinted()', value: 700n }], cap: [{ sig: 'maxShares()', value: 1000n }, { sig: 'MAX_SUPPLY()', value: 2000n }] }).reason, /不一致/);
});
test('pickProgress：totalSupply 只在别的读不到时才用', () => {
  const both = pickProgress({ sold: [{ sig: 'totalMinted()', value: 600n }, { sig: SOLD_FALLBACK, value: 999n }], cap: [{ sig: 'cap()', value: 1000n }] });
  assert.equal(both.pct, 60);
  const only = pickProgress({ sold: [{ sig: 'totalMinted()', value: null }, { sig: SOLD_FALLBACK, value: 800n }], cap: [{ sig: 'cap()', value: 1000n }] });
  assert.equal(only.pct, 80); assert.equal(only.soldSig, SOLD_FALLBACK);
});
test('pickProgress：读不到 → 不通过；--cap 优先于读数', () => {
  assert.equal(pickProgress({ sold: [{ sig: 'sold()', value: null }], cap: [{ sig: 'cap()', value: 10n }] }).ok, false);
  assert.match(pickProgress({ sold: [{ sig: 'sold()', value: 1n }], cap: [{ sig: 'cap()', value: null }] }).reason, /--cap/);
  const r = pickProgress({ sold: [{ sig: 'sold()', value: 50n }], cap: [] }, { capOverride: 100n });
  assert.equal(r.pct, 50); assert.equal(r.capSig, '--cap');
});
test('pickProgress：单位不一致（已铸按 wei、上限按份）→ >100% 不通过', () => {
  const r = pickProgress({ sold: [{ sig: 'totalSupply()', value: 600n * E18 }], cap: [{ sig: 'maxShares()', value: 1000n }] });
  assert.equal(r.ok, false); assert.match(r.reason, />100%/);
});
test('FN_RE：只收无参数函数', () => {
  assert.ok(FN_RE.test('totalMinted()'));
  assert.ok(!FN_RE.test('balanceOf(address)'));
  assert.ok(!FN_RE.test('x(); rm'));
});

// ---------- 预算 ----------
test('spentUsdFor：按钱包 + 项目（pid 或合约）算；有 usd 用 usd，老记录按现价折算，USDT 按 1:1', () => {
  const L = [
    { pid: 'demo', contract: MINT, bnb: 0.01, usd: 6 },                // 主钱包（没写 wallet）
    { pid: 'other', contract: MINT, bnb: 0.02, wallet: 'main' },       // 同合约、老记录 → 0.02 × 600
    { pid: 'demo', contract: OTHER, usdt: 5, wallet: 'main' },         // 同项目、USDT
    { pid: 'demo', contract: MINT, bnb: 1, usd: 600, wallet: 'w2' },   // 别的钱包
    { pid: 'x', contract: OTHER, bnb: 1, usd: 600 },                   // 别的项目
  ];
  assert.equal(spentUsdFor(L, { pid: 'demo', contracts: [MINT.toUpperCase().replace('0X', '0x')], walletId: 'main', mainId: 'main', usdPerBnb: 600 }), 6 + 12 + 5);
  assert.equal(spentUsdFor(L, { pid: 'demo', contracts: [MINT], walletId: 'w2', mainId: 'main', usdPerBnb: 600 }), 600);
  assert.equal(spentUsdFor([], { pid: 'demo', contracts: [MINT], walletId: 'main', mainId: 'main', usdPerBnb: null }), 0);
  assert.equal(spentUsdFor([{ pid: 'demo', bnb: 0.1 }], { pid: 'demo', contracts: [], walletId: 'main', mainId: 'main', usdPerBnb: null }), null);   // 有 BNB 老记录又没价格：算不出
});
test('planShare：在预算内全买；超了一份份减；一份都放不下 → 0', async () => {
  const unit = 10n ** 16n;   // 0.01 BNB / 份，BNB=$600 → $6 / 份
  const totalOf = async q => BigInt(q) * unit;
  const ctx = { budgetUsd: 30, usdPerBnb: 600 };
  assert.equal((await planShare({ free: 0, want: 4, totalOf }, { ...ctx, spentUsd: 0 })).paid, 4);
  const r = await planShare({ free: 0, want: 10, totalOf }, { ...ctx, spentUsd: 0 });
  assert.equal(r.paid, 5); assert.equal(r.total, 5n * unit); assert.ok(Math.abs(r.usd - 30) < 1e-9); assert.match(r.notes[0], /减到 5 份/);
  assert.equal((await planShare({ free: 0, want: 10, totalOf }, { ...ctx, spentUsd: 20 })).paid, 1);
  const z = await planShare({ free: 0, want: 3, totalOf }, { ...ctx, spentUsd: 26 });
  assert.equal(z.paid, 0); assert.equal(z.total, 0n); assert.match(z.notes[0], /已到上限/);
  assert.match((await planShare({ free: 0, want: 3, totalOf }, { ...ctx, spentUsd: 30 })).notes[0], /已到上限/);
});
test('planShare：设了每日上限（所有钱包合计）也照样减', async () => {
  const totalOf = async q => BigInt(q) * 10n ** 16n;
  const r = await planShare({ free: 0, want: 5, totalOf }, { budgetUsd: 30, spentUsd: 0, usdPerBnb: 600, maxDailyBnb: 0.05, spentTodayBnb: 0.03 });
  assert.equal(r.paid, 2); assert.match(r.notes[0], /每日上限/);
  assert.equal((await planShare({ free: 0, want: 5, totalOf }, { budgetUsd: 30, spentUsd: 0, usdPerBnb: 600, maxDailyBnb: null, spentTodayBnb: 9 })).paid, 5);
});
test('planShare：免费份不占预算（报价按 free+paid 算）', async () => {
  const totalOf = async q => BigInt(Math.max(0, q - 2)) * 10n ** 16n;   // 前 2 份免费
  const r = await planShare({ free: 2, want: 5, totalOf }, { budgetUsd: 30, spentUsd: 0, usdPerBnb: 600 });
  assert.equal(r.paid, 5);
});
test('planShare：读不到价格 / 报价 / 已花 → 不付', async () => {
  const totalOf = async () => 1n;
  assert.equal((await planShare({ free: 0, want: 1, totalOf }, { budgetUsd: 30, spentUsd: 0, usdPerBnb: null })).paid, 0);
  assert.equal((await planShare({ free: 0, want: 1, totalOf }, { budgetUsd: 30, spentUsd: null, usdPerBnb: 600 })).paid, 0);
  assert.equal((await planShare({ free: 0, want: 1, totalOf: async () => null }, { budgetUsd: 30, spentUsd: 0, usdPerBnb: 600 })).paid, 0);
  assert.equal((await planShare({ free: 0, want: 0, totalOf }, { budgetUsd: 30, spentUsd: 0, usdPerBnb: 600 })).paid, 0);
});

// ---------- 源码审查记录 ----------
test('checkReview：四项都是 true + by + at → 通过', () => {
  assert.deepEqual(checkReview(REVIEW, { contract: MINT, token: TOKEN, now: NOW }), []);
  assert.deepEqual(checkReview({ ...REVIEW, contract: MINT.toUpperCase().replace('0X', '0x'), token: TOKEN }, { contract: MINT, token: TOKEN, now: NOW }), []);
});
test('checkReview：缺记录、字符串 "true"、缺 by / at、未来时间、合约对不上 → 不通过', () => {
  assert.equal(checkReview(null, { now: NOW }).length, 1);
  assert.match(checkReview({ ...REVIEW, lpBurned: 'true' }, { now: NOW }).join(), /lpBurned/);
  assert.match(checkReview({ ...REVIEW, fundsStay: false }, { now: NOW }).join(), /fundsStay/);
  assert.match(checkReview({ ...REVIEW, by: '' }, { now: NOW }).join(), /by/);
  assert.match(checkReview({ ...REVIEW, at: 'yesterday' }, { now: NOW }).join(), /at/);
  assert.match(checkReview({ ...REVIEW, at: '2026-11-02T00:00:00Z' }, { now: NOW }).join(), /未来/);
  assert.match(checkReview({ ...REVIEW, contract: OTHER }, { contract: MINT, token: TOKEN, now: NOW }).join(), /铸造合约/);
  assert.match(checkReview({ ...REVIEW, token: OTHER }, { contract: MINT, token: TOKEN, now: NOW }).join(), /代币合约/);
});

// ---------- 五道关口 ----------
const good = () => ({
  progress: computeProgress(700n, 1000n), threshold: 65, pay: 'bnb', usdPerBnb: 600, budgetUsd: 30,
  wallets: [{ id: 'main', spentUsd: 0 }, { id: 'w2', spentUsd: 30 }],
  verified: { mint: 'exact_match', token: 'match', tokenAddr: TOKEN }, review: REVIEW, contract: MINT, token: TOKEN, now: NOW,
  devcheck: { verdict: '可打，但有提醒', block: [], warn: ['合约里几乎没有 BNB'] },
});
test('关口：全部满足 → 通过', () => {
  const r = evaluateGates(good());
  assert.equal(r.pass, true); assert.deepEqual(r.failed, []); assert.equal(r.gates.length, 5);
});
test('关口①：进度低于门槛 / 读不准 → 不通过', () => {
  assert.deepEqual(evaluateGates({ ...good(), progress: computeProgress(600n, 1000n) }).failed, ['进度']);
  assert.deepEqual(evaluateGates({ ...good(), progress: { ok: false, reason: '读不到' } }).failed, ['进度']);
  assert.deepEqual(evaluateGates({ ...good(), progress: computeProgress(650n, 1000n), threshold: 65 }).failed, []);   // 等于门槛算达到
});
test('关口②：USDT 付款、读不到 BNB 价格、所有钱包都到上限 → 不通过', () => {
  assert.match(evaluateGates({ ...good(), pay: 'usdt' }).gates[1].detail, /USDT/);
  assert.deepEqual(evaluateGates({ ...good(), pay: 'usdt' }).failed, ['预算']);
  assert.deepEqual(evaluateGates({ ...good(), usdPerBnb: null }).failed, ['预算']);
  assert.deepEqual(evaluateGates({ ...good(), wallets: [{ id: 'main', spentUsd: 30 }, { id: 'w2', spentUsd: null }] }).failed, ['预算']);
  assert.deepEqual(evaluateGates({ ...good(), wallets: [] }).failed, ['预算']);
});
test('关口③：铸造合约或代币合约没验证、没有代币地址 → 不通过', () => {
  assert.deepEqual(evaluateGates({ ...good(), verified: { mint: null, token: 'match', tokenAddr: TOKEN } }).failed, ['源码验证']);
  assert.deepEqual(evaluateGates({ ...good(), verified: { mint: 'match', token: null, tokenAddr: TOKEN } }).failed, ['源码验证']);
  assert.match(evaluateGates({ ...good(), verified: { mint: 'match', token: null, tokenAddr: null } }).gates[2].detail, /代币合约地址/);
});
test('关口④：审查记录不全 → 不通过', () => {
  assert.deepEqual(evaluateGates({ ...good(), review: { ...REVIEW, noWithdraw: false } }).failed, ['源码审查']);
  assert.deepEqual(evaluateGates({ ...good(), review: undefined }).failed, ['源码审查']);
});
test('关口⑤：防骗检查「拦」或没跑完 → 不通过', () => {
  assert.deepEqual(evaluateGates({ ...good(), devcheck: { verdict: '拦', block: ['诱饵盘'], warn: [] } }).failed, ['防骗检查']);
  assert.deepEqual(evaluateGates({ ...good(), devcheck: { error: 'RPC 超时' } }).failed, ['防骗检查']);
  assert.deepEqual(evaluateGates({ ...good(), devcheck: null }).failed, ['防骗检查']);
  assert.deepEqual(evaluateGates({ ...good(), devcheck: { verdict: '通过' } }).failed, ['防骗检查']);   // 格式不对
});
test('关口：多道不过时全部列出', () => {
  const r = evaluateGates({ ...good(), progress: computeProgress(1n, 1000n), pay: 'usdt', review: null });
  assert.deepEqual(r.failed, ['进度', '预算', '源码审查']);
});

// ---------- 通行证 ----------
test('gateValid：token / 项目 / 合约一致且没过期才通过', () => {
  const g = { token: 'a'.repeat(32), pid: 'demo', contract: MINT, at: new Date(NOW - 60_000).toISOString(), budgetUsd: 30 };
  const q = { token: 'a'.repeat(32), pid: 'demo', contract: MINT.toUpperCase().replace('0X', '0x'), now: NOW };
  assert.equal(gateValid(g, q), null);
  assert.match(gateValid(null, q), /没有/);
  assert.match(gateValid(g, { ...q, token: 'b'.repeat(32) }), /不匹配/);
  assert.match(gateValid({ ...g, token: 'short' }, { ...q, token: 'short' }), /不匹配/);
  assert.match(gateValid(g, { ...q, pid: 'other' }), /不是这个项目/);
  assert.match(gateValid(g, { ...q, contract: OTHER }), /不是这个项目/);
  assert.match(gateValid({ ...g, at: new Date(NOW - GATE_TTL_MS - 1).toISOString() }, q), /过期/);
  assert.match(gateValid({ ...g, budgetUsd: 0 }, q), /预算/);
});

// ---------- 配置 ----------
test('validateShareMint：不写可以；写了类型要对', () => {
  assert.deepEqual(validateShareMint(undefined), []);
  assert.deepEqual(validateShareMint({ enabled: false, budgetUsd: 30 }), []);
  assert.equal(validateShareMint({ enabled: 'true', budgetUsd: 30 }).length, 1);
  assert.equal(validateShareMint({ enabled: true, budgetUsd: '30' }).length, 1);
  assert.equal(validateShareMint({ enabled: true, budgetUsd: 0 }).length, 1);
  assert.equal(validateShareMint({ enabled: true, budgetUsd: 1e9 }).length, 1);
  assert.equal(validateShareMint([]).length, 1);
});
