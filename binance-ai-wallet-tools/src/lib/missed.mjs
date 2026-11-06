// 掉线补领的纯逻辑：不联网。src/auto/backfill.mjs（运行）和 src/cli/backfill.mjs（手动）调用，test/ 里有单元测试。
// 思路：某个钱包掉线期间，别的钱包领过的免费项目（花费账 spend.jsonl 里 bnb = 0、有交易哈希的记录），这个钱包可能也能领。
// 把那笔交易的调用数据里「那个钱包的地址」换成「这个钱包的地址」，value = 0 预演；预演必须零扣款、零授权、零风险提示、
// 不要求 App 确认，而且确实收到了东西，才执行。
import { checkPreview } from './rules.mjs';

const lc = a => String(a || '').toLowerCase();
const ADDR = /^0x[0-9a-fA-F]{40}$/;

// 候选：since 之后别的钱包免费领过、这个钱包没领过、也没补过的项目（每个项目取最早的一笔做样板）
//   spends  spend.jsonl 的记录；wallets [{ id, address, main }]；id 这个钱包；done 补领状态 { 项目id: 结果 }
export function missedCandidates(spends, { wallets, id, since, done = {} }) {
  const mainId = wallets.find(w => w.main)?.id;
  const widOf = x => String(x.wallet || mainId).toLowerCase(), me = String(id).toLowerCase();
  const others = new Map(wallets.filter(w => w.id.toLowerCase() !== me).map(w => [w.id.toLowerCase(), lc(w.address)]));
  const mine = new Set(spends.filter(x => widOf(x) === me).map(x => x.pid));
  const paidPid = new Set(spends.filter(x => Number(x.bnb || 0) > 0 || Number(x.paid || 0) > 0).map(x => x.pid));   // 只要有人付过钱的项目就不碰
  const sinceIso = new Date(since).toISOString(), out = new Map();
  for (const x of spends) {
    if (!x || String(x.ts) < sinceIso || !others.has(widOf(x)) || !/^0x[0-9a-fA-F]{64}$/.test(String(x.tx || ''))) continue;
    if (paidPid.has(x.pid) || mine.has(x.pid) || done[x.pid] || out.has(x.pid)) continue;
    out.set(x.pid, { pid: x.pid, contract: x.contract, tx: x.tx, from: others.get(widOf(x)) });
  }
  return [...out.values()];
}

// 调用数据里把 from 的地址（按 32 字节对齐的参数位）全换成 to。不对齐的地方不动（防止误伤别的数据）
export function swapAddress(input, from, to) {
  const s = String(input || '');
  if (!/^0x[0-9a-fA-F]{8}([0-9a-fA-F]{64})*$/.test(s) || !ADDR.test(from) || !ADDR.test(to)) return null;
  const f = lc(from).slice(2).padStart(64, '0'), t = lc(to).slice(2).padStart(64, '0');
  return s.slice(0, 10) + (s.slice(10).match(/.{64}/g) || []).map(w => w.toLowerCase() === f ? t : w).join('');
}

// 样板交易本身要能用：成功、发给合约、不付 BNB
export function sampleUsable(tx, rc) {
  if (!tx || !rc) return '读不到样板交易';
  if (rc.status !== '0x1') return '样板交易本身失败了';
  if (!tx.to) return '样板是创建合约的交易';
  if (BigInt(tx.value || 0) !== 0n) return '样板付了 BNB，不是免费的';
  return null;
}

// 补领的预演：本钱包不能有任何扣款（连 BNB 都不行）、授权 / 权限变化、风险提示、二次确认；而且必须收到东西
export function checkReplayPreview(pv, { me }) {
  const p = checkPreview(pv, { me, total: 0n });
  const got = (pv?.simulationResult?.balanceChanges || []).some(b => lc(b?.owner) === lc(me) && Number(b?.change) > 0);
  if (!got) p.push('预演里什么都没收到');
  return p;
}

// 钱包登录状态的变化：掉线 → 在线时返回该补领的起点（掉线时间往前 2 小时，防止临界那段漏掉）
//   prev { up: boolean, downAt?: ISO }，up 这次是否在线
export function loginTransition(prev, up, now = Date.now()) {
  const was = prev?.up;
  if (up && was === false) return { next: { up: true }, backfillFrom: (Date.parse(prev.downAt) || now) - 2 * 3600_000 };
  if (!up && was !== false) return { next: { up: false, downAt: new Date(now).toISOString() }, backfillFrom: null };
  return { next: prev && was === up ? prev : up ? { up: true } : { up: false, downAt: prev?.downAt || new Date(now).toISOString() }, backfillFrom: null };
}
