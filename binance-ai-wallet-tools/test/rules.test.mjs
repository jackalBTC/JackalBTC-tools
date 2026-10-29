// 花钱规则、预演检查、ABI 报价识别的单元测试。运行：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPreview, planPaid, pickQuoteFromAbi } from '../src/lib/rules.mjs';

const ME = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const NFT = '0x3333333333333333333333333333333333333333';
const ok = (balanceChanges = [], extra = {}) => ({
  requestId: 'r1', requireConfirmation: false,
  risks: { addresses: {}, riskDetails: [], riskBehaviors: [] },
  simulationResult: { simulationCode: '000000000', balanceChanges, allowanceChanges: [], authorityChanges: [] },
  ...extra,
});

// ---------- checkPreview ----------
test('预演：只收到 NFT、不付钱 → 通过', () => {
  assert.deepEqual(checkPreview(ok([{ owner: ME, tokenType: 'Erc721', change: 1, contractAddress: NFT }]), { me: ME, total: 0n }), []);
});
test('预演：付出的 BNB 不超过报价 → 通过；超过 → 不通过', () => {
  const pv = ok([{ owner: ME, tokenType: 'Native', change: -500, contractAddress: '0xeeee' }]);
  assert.deepEqual(checkPreview(pv, { me: ME, total: 500n }), []);
  assert.match(checkPreview(pv, { me: ME, total: 499n }).join(), /额外扣款/);
});
test('预演：ERC20 或 NFT 被转出 → 不通过', () => {
  assert.match(checkPreview(ok([{ owner: ME, tokenType: 'Erc20', change: -1, contractAddress: OTHER }]), { me: ME, total: 0n }).join(), /额外扣款/);
  assert.match(checkPreview(ok([{ owner: ME, tokenType: 'Erc721', change: -1, contractAddress: NFT }]), { me: ME, total: 0n }).join(), /额外扣款/);
});
test('预演：别人的余额变化不影响', () => {
  assert.deepEqual(checkPreview(ok([{ owner: OTHER, tokenType: 'Erc20', change: -9, contractAddress: OTHER }]), { me: ME, total: 0n }), []);
});
test('预演：有授权 / 权限变化 / 风险 / 风险地址 / 二次确认 → 不通过', () => {
  const base = ok();
  assert.match(checkPreview({ ...base, simulationResult: { ...base.simulationResult, allowanceChanges: [{}] } }, { me: ME, total: 0n }).join(), /授权/);
  assert.match(checkPreview({ ...base, simulationResult: { ...base.simulationResult, authorityChanges: [{}] } }, { me: ME, total: 0n }).join(), /权限/);
  assert.match(checkPreview({ ...base, risks: { addresses: {}, riskDetails: ['x'], riskBehaviors: [] } }, { me: ME, total: 0n }).join(), /风险/);
  assert.match(checkPreview({ ...base, risks: { addresses: { [OTHER]: { riskLevel: 'HIGH' } }, riskDetails: [], riskBehaviors: [] } }, { me: ME, total: 0n }).join(), /风险/);
  assert.match(checkPreview({ ...base, requireConfirmation: true }, { me: ME, total: 0n }).join(), /二次确认/);
});
test('预演：缺字段、看不懂的格式、模拟码 / 预检码异常、没有 requestId → 不通过', () => {
  assert.ok(checkPreview({}, { me: ME, total: 0n }).length >= 2);
  assert.match(checkPreview(ok([{ address: ME, delta: -1 }]), { me: ME, total: 0n }).join(), /看不懂/);
  assert.match(checkPreview(ok([{ owner: ME, tokenType: 'Weird', change: 1 }]), { me: ME, total: 0n }).join(), /看不懂/);
  const b = ok();
  assert.match(checkPreview({ ...b, simulationResult: { ...b.simulationResult, simulationCode: '351805' } }, { me: ME, total: 0n }).join(), /模拟码/);
  assert.match(checkPreview({ ...b, simulationResult: { ...b.simulationResult, preCheckCode: '1' } }, { me: ME, total: 0n }).join(), /预检码/);
  assert.match(checkPreview({ ...b, requestId: undefined }, { me: ME, total: 0n }).join(), /requestId/);
});

// ---------- planPaid ----------
const S = { allowAutoPaid: true, maxUnitUsd: 3, maxPaidPerProject: 10, maxDailyBnb: 0.02, gasLikeBnb: 0.0005 };
const ctx = (o = {}) => ({ spending: S, usdPerBnb: 600, verified: 'exact_match', official: true, freeOnly: false, clone: null, spentToday: 0, paidSoFar: 0, ...o });
const perUnit = wei => async q => BigInt(q) * wei;   // 免费 0 张时，q 张总价
const E = 10n ** 18n;

test('付费：满足所有条件 → 全部付', async () => {
  const r = await planPaid({ free: 0, paid: 3, totalOf: perUnit(E / 1000n) }, ctx());   // 0.001 BNB ≈ $0.6/张
  assert.equal(r.paid, 3); assert.equal(r.total, 3n * E / 1000n);
});
test('付费：没开自动付费 / 未验证 / 无官源 / 模板 / 只要免费 → 一张都不付', async () => {
  for (const o of [{ spending: { ...S, allowAutoPaid: false } }, { verified: null }, { official: false }, { clone: '同模板' }, { freeOnly: true }]) {
    const r = await planPaid({ free: 1, paid: 3, totalOf: perUnit(E / 1000n) }, ctx(o));
    assert.equal(r.paid, 0, JSON.stringify(o)); assert.equal(r.total, 0n);
  }
});
test('付费：配置里 allowAutoPaid 是字符串也不算开启', async () => {
  const r = await planPaid({ free: 0, paid: 2, totalOf: perUnit(E / 1000n) }, ctx({ spending: { ...S, allowAutoPaid: 'true' } }));
  assert.equal(r.paid, 0);
});
test('付费：单价超过上限 → 不付；但合计视同 gas 时不看单价', async () => {
  assert.equal((await planPaid({ free: 0, paid: 1, totalOf: perUnit(E / 100n) }, ctx())).paid, 0);              // 0.01 BNB ≈ $6
  assert.equal((await planPaid({ free: 0, paid: 1, totalOf: perUnit(E / 2500n) }, ctx({ usdPerBnb: 1e6 }))).paid, 1);  // 0.0004 BNB 视同 gas
});
test('付费：按合约累计张数减到上限', async () => {
  const r = await planPaid({ free: 0, paid: 5, totalOf: perUnit(E / 1000n) }, ctx({ paidSoFar: 8 }));
  assert.equal(r.paid, 2); assert.match(r.notes.join(), /减到 2/);
});
test('付费：按每日上限往下减，到 0 就不付', async () => {
  assert.equal((await planPaid({ free: 0, paid: 5, totalOf: perUnit(E / 1000n) }, ctx({ spentToday: 0.017 }))).paid, 3);
  assert.equal((await planPaid({ free: 0, paid: 5, totalOf: perUnit(E / 1000n) }, ctx({ spentToday: 0.02 }))).paid, 0);
});
test('付费：读不到报价 → 不付', async () => {
  assert.equal((await planPaid({ free: 0, paid: 2, totalOf: async () => null }, ctx())).paid, 0);
});

// ---------- pickQuoteFromAbi ----------
const fn = (name, inputs, outputs) => ({ type: 'function', stateMutability: 'view', name, inputs: inputs.map(([type, name]) => ({ type, name })), outputs: outputs.map(([type, name]) => ({ type, name })) });
test('ABI 报价：(free, cost) 选 cost；(cents, wei) 选 wei', () => {
  assert.deepEqual(pickQuoteFromAbi([fn('quote', [['address', 'a'], ['uint256', 'qty']], [['uint256', 'free'], ['uint256', 'cost']])]), { sig: 'quote(address,uint256)', args: ['wallet', 'qty'], out: 1 });
  assert.equal(pickQuoteFromAbi([fn('quoteMint', [['address', 'account'], ['uint256', 'quantity']], [['uint256', 'costCents'], ['uint256', 'costWei']])]).out, 1);
});
test('ABI 报价：带 Agent ID 参数的也能识别', () => {
  assert.deepEqual(pickQuoteFromAbi([fn('quoteMint', [['uint256', 'agentTokenId'], ['uint256', 'quantity']], [['uint256', '']])]).args, ['agentId', 'qty']);
});
test('ABI 报价：返回值含义不明（多个无名 uint）→ 不认', () => {
  assert.equal(pickQuoteFromAbi([fn('quoteMint', [['address', 'a'], ['uint256', 'qty']], [['uint256', ''], ['bool', '']])]), null);
});
test('ABI 报价：没有数量参数的不认（单价函数由别处处理）', () => {
  assert.equal(pickQuoteFromAbi([fn('quote', [['address', 'a']], [['uint256', 'cost']])]), null);
});
