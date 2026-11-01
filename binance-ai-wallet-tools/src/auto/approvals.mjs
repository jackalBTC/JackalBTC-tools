// 授权巡检（只读，默认开：config.approvalWatch）。每 everyMinutes（30）分钟用 baw approvals list 看各钱包的代币授权，
// 新出现的授权写一条项目动态（Telegram 会推）；无限额或币安标了风险的是「重要」（响铃）。
// 第一次跑只记底，不提醒。只提醒，从不撤销。状态在 data/approvals-state.json。
import { config, readJson, writeJson } from '../lib/config.mjs';
import { baw } from '../lib/chain.mjs';
import { listWallets, envFor } from '../lib/wallets.mjs';
import { diffApprovals, approvalNews, isUnlimited } from '../lib/approvals.mjs';
import { log, addNews, DRY } from './common.mjs';

let at = 0;
const listOf = r => r?.data?.list || r?.data?.approvals || (Array.isArray(r?.data) ? r.data : null);

export async function approvalTick() {
  const A = config.approvalWatch;
  if (!A?.enabled || Date.now() - at < A.everyMinutes * 60_000) return;
  at = Date.now();
  const S = readJson('approvals-state.json', {});
  for (const w of await listWallets()) {
    const r = await baw(['approvals', 'list', '--limit', '100'], envFor(w));
    const list = r?.success ? listOf(r) : null;
    if (!list) { log('ERR approvals', w.id, String(r?.error?.message || '读不到授权列表').slice(0, 120)); continue; }
    const d = diffApprovals(S[w.id], list);
    S[w.id] = d.keys;
    if (d.first) { log('APPROVALS 记底', w.id, list.length, '条'); continue; }
    for (const a of d.fresh) {
      const n = approvalNews(a, w.label || w.id);
      addNews('approvals', n.level, n.title, n.summary);
      log('APPROVAL NEW', w.id, a.tokenSymbol || a.tokenContract, a.spender, isUnlimited(a.amount) ? 'unlimited' : a.amount);
    }
  }
  if (!DRY) writeJson('approvals-state.json', S);
}
