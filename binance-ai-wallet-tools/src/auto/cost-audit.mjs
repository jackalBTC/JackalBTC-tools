// 成本自检（不发交易，默认开：config.costAudit）。每小时一次：花费账 data/spend.jsonl 里付过 BNB、
// 持仓 watch.json 里这个系列成本却是空 / 0 的，按账上实际付出补上，写一条操作日志和一条「注意」级项目动态。
// 成本记成 0 的话，看板盈亏和自动止盈的倍数都会算错。规则见 src/lib/costaudit.mjs。
import { config, tailLines } from '../lib/config.mjs';
import { listWallets, readWatch, writeWatch } from '../lib/wallets.mjs';
import { paidByWallet, auditWatch } from '../lib/costaudit.mjs';
import { log, addNews, event, DRY } from './common.mjs';

let at = 0;
export async function costAuditTick() {
  if (!config.costAudit?.enabled || Date.now() - at < 3600_000) return;
  at = Date.now();
  const W = await listWallets(), main = W.find(w => w.main)?.id || 'main';
  const paid = paidByWallet(tailLines('spend.jsonl', 100000), main);
  if (!paid.size) return;
  for (const w of W) {
    const watch = readWatch(w), fixed = auditWatch(watch, w.id, paid);
    if (!fixed.length) continue;
    const text = fixed.map(f => `${f.name} ${f.bnb} BNB`).join('；');
    if (DRY) { log('[试运行] COST FIX', w.id, text); continue; }
    writeWatch(w, watch);
    for (const f of fixed) if (/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(f.id || '')) event(f.id, 'verify', `成本自检补记：花费账里付过 ${f.bnb} BNB，持仓成本原来是空的，已补上`, {}, w);
    addNews('cost-audit', '注意', '持仓成本补记', `${w.label || w.id} 有 ${fixed.length} 个项目付过钱但成本记成了 0 / 空，已按花费账补上：${text}。`);
    log('COST FIX', w.id, text);
  }
}
