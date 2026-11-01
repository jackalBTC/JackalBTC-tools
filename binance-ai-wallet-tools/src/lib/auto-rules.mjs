// 自动领取 / 自动兑换的检查规则：纯函数，不联网。src/auto/ 调用，test/ 里有单元测试。
// 和铸造一样，预演检查写死在代码里，配置关不掉；缺字段、看不懂的格式一律不通过。
import { checkPreview } from './rules.mjs';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const lc = a => String(a || '').toLowerCase();
const received = (pv, me, token) => (pv?.simulationResult?.balanceChanges || []).filter(b => lc(b?.owner) === lc(me) && lc(b?.contractAddress) === lc(token) && Number(b?.change) > 0);

// ---------- 自动领取（data/claims.json） ----------
// 一条登记：{ id, project, name, wallet?, to, data, token, symbol, notBefore, cost?, firstTp?, ladder?, back3?, hold?, sellOnce? }
export function validateClaim(c) {
  const e = [];
  if (!c || typeof c !== 'object') return ['不是对象'];
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(String(c.project || ''))) e.push('project 只能用字母、数字、- 和 _');
  if (c.wallet != null && !/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(String(c.wallet))) e.push('wallet 格式不对');
  if (!ADDR.test(c.to || '')) e.push('to 必须是完整的合约地址');
  if (!ADDR.test(c.token || '')) e.push('token 必须是完整的代币地址');
  if (!/^0x[0-9a-fA-F]{8}([0-9a-fA-F]{64})*$/.test(c.data || '')) e.push('data 必须是 0x + 4 字节函数选择器 + 32 字节参数');
  if (!Number.isFinite(Date.parse(c.notBefore))) e.push('notBefore 必须是时间，例如 2026-11-02T12:00:00+08:00');
  if (c.value != null && String(c.value) !== '0') e.push('自动领取只做不付钱的（不要写 value）');
  return e;
}
// 领取的预演：本钱包不能有任何扣款（连 BNB 都不行）、授权 / 权限变化、风险提示、二次确认，而且必须收到登记的代币
export function checkClaimPreview(pv, { me, token }) {
  const p = checkPreview(pv, { me, total: 0n });
  if (!received(pv, me, token).length) p.push('预演里没收到登记的代币');
  return p;
}

// ---------- 自动兑换（卡 / NFT 换代币） ----------
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const addrOf = t => '0x' + String(t).slice(-40).toLowerCase();
export const SINKS = ['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead'];
// 收到这些不算「换到了项目代币」（是卖 NFT 收的钱）：WBNB、USDT、USDC、BUSD
export const NOT_REWARD = new Set(['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', '0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0xe9e7cea3dedca5984780bafc599bd69add087d56']);

// 从别人的一笔交易里认出「烧卡换代币」的样板，认不出返回 null。条件：
//   交易成功；不付 BNB（公开版只照抄零付费的）；不是发给 NFT 市场的（卖卡不是兑换）；
//   同一笔里发起人把这个系列的卡转给了 0x0 / 0xdead / 系列合约本身 / 被调用的合约，并且收到了别的 ERC20（不是常见计价币）
export function findRedeemSample(tx, rc, nft, { markets = [] } = {}) {
  if (!tx?.to || !tx.from || !rc || rc.status !== '0x1' || !/^0x[0-9a-fA-F]{8}/.test(tx.input || '')) return null;
  if (BigInt(tx.value || 0) !== 0n) return null;
  const to = lc(tx.to), me = lc(tx.from), c = lc(nft);
  if (markets.map(lc).includes(to)) return null;
  const logs = rc.logs || [];
  const burned = logs.filter(l => lc(l.address) === c && l.topics?.[0] === TRANSFER && l.topics.length === 4 && addrOf(l.topics[1]) === me && [...SINKS, c, to].includes(addrOf(l.topics[2])));
  const got = logs.find(l => l.topics?.[0] === TRANSFER && l.topics.length === 3 && addrOf(l.topics[2]) === me && lc(l.address) !== c && !NOT_REWARD.has(lc(l.address)));
  if (!burned.length || !got) return null;
  return { to, input: tx.input, from: me, ids: burned.map(l => BigInt(l.topics[3]).toString()), token: lc(got.address), tx: tx.hash || null };
}

// 照抄样板的调用数据：把他的卡号换成我们的（按顺序一一对应），他的地址换成我们的。
// 卡号在调用数据里必须恰好出现一次（例如卡号 1 和数组长度 1 撞在一起就分不清），否则返回 null，不冒险
export function replayCalldata(sample, ourIds, ourAddr) {
  const body = String(sample?.input || '').slice(10);
  if (!/^0x[0-9a-fA-F]{8}$/.test(String(sample?.input || '').slice(0, 10)) || body.length % 64 || !ADDR.test(ourAddr || '')) return null;
  if (!Array.isArray(ourIds) || ourIds.length !== sample.ids.length) return null;
  const W = body.match(/.{64}/g) || [], w = v => BigInt(v).toString(16).padStart(64, '0');
  const sub = new Map();
  for (const [j, id] of sample.ids.entries()) {
    const k = w(id);
    if (W.filter(x => x.toLowerCase() === k).length !== 1) return null;
    sub.set(k, w(ourIds[j]));
  }
  const from = String(sample.from).slice(2).toLowerCase().padStart(64, '0'), mine = ourAddr.slice(2).toLowerCase().padStart(64, '0');
  return sample.input.slice(0, 10) + W.map(x => sub.get(x.toLowerCase()) || (x.toLowerCase() === from ? mine : x)).join('');
}

// 兑换的预演：除了交出这几张卡（本系列 NFT 减少，最多 cards 张），本钱包不能有任何扣款（不付 BNB）；
// 不能有授权 / 权限变化、风险提示、二次确认；必须收到样板里的那个代币
export function checkRedeemPreview(pv, { me, nft, token, cards }) {
  const s = pv?.simulationResult;
  const isCard = b => lc(b?.owner) === lc(me) && lc(b?.contractAddress) === lc(nft) && /^erc(721|1155)$/i.test(String(b?.tokenType || '')) && Number(b?.change) < 0;
  const gave = (s?.balanceChanges || []).filter(isCard).reduce((a, b) => a - Number(b.change), 0);
  const rest = s && Array.isArray(s.balanceChanges) ? { ...pv, simulationResult: { ...s, balanceChanges: s.balanceChanges.filter(b => !isCard(b)) } } : pv;
  const p = checkPreview(rest, { me, total: 0n });
  if (gave > cards) p.push(`要交出 ${gave} 张卡，比这次兑换的 ${cards} 张多`);
  if (!received(pv, me, token).length) p.push('预演里没收到代币');
  return p;
}
