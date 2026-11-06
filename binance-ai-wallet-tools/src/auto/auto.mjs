#!/usr/bin/env node
// 后台自动任务（可选服务 auto）。每 1 分钟看一次，各任务按自己的间隔跑：
//   marketWatch        Element 市场监控（只读，默认开）                       src/auto/market.mjs
//   approvalWatch      授权巡检（只读，只提醒不撤销，默认开）                 src/auto/approvals.mjs
//   costAudit          成本自检（不发交易，只补持仓里空 / 0 的成本，默认开）  src/auto/cost-audit.mjs
//   auto.claims        到点自动领取（会发交易，默认关）                        src/auto/claims.mjs
//   auto.redeem        卡 / NFT 自动兑换代币（会发交易，默认关）               src/auto/redeem.mjs
//   auto.takeProfit    自动止盈（会卖币，默认关）                              src/auto/take-profit.mjs
//   auto.backfill      掉线补领（会发交易，只做零付费的，默认关）               src/auto/backfill.mjs
//   pnl.auto           钱包整体盈亏（只读，默认关；手动 npm run pnl）           src/auto/pnl.mjs
// 会发交易的三项都要在 config/config.json 里明确打开，打开前读 docs/auto.md。
// 用法: node src/auto/auto.mjs [--once] [--dry]
//   --once  跑一轮就退出      --dry  试运行：只模拟和预演，不执行、不卖、不写状态（各任务的间隔不限制）
import { config } from '../lib/config.mjs';
import { log, DRY } from './common.mjs';
import { marketTick } from './market.mjs';
import { claimTick } from './claims.mjs';
import { redeemTick } from './redeem.mjs';
import { takeProfitTick } from './take-profit.mjs';
import { approvalTick } from './approvals.mjs';
import { costAuditTick } from './cost-audit.mjs';
import { backfillTick } from './backfill.mjs';
import { pnlTick } from './pnl.mjs';

const A = config.auto || {}, on = [];
if (config.marketWatch?.enabled) on.push('Element 市场监控（只读）');
if (config.approvalWatch?.enabled) on.push('授权巡检（只读）');
if (config.costAudit?.enabled) on.push('成本自检');
if (A.claims?.enabled) on.push('到点自动领取');
if (A.redeem?.enabled) on.push('自动兑换');
if (A.takeProfit?.enabled) on.push('自动止盈');
if (A.backfill?.enabled) on.push('掉线补领');
if (config.pnl?.auto) on.push('钱包整体盈亏（只读）');
log('START 后台自动任务', DRY ? '（试运行）' : '', on.length ? '：' + on.join('、') : '：全部关着（看 config/config.json 的 marketWatch / approvalWatch / costAudit / auto）');

let busy = false;
async function tick() {
  if (busy) return; busy = true;
  try {
    for (const [name, fn] of [['market', marketTick], ['approvals', approvalTick], ['cost-audit', costAuditTick], ['claim', claimTick], ['redeem', redeemTick], ['take-profit', takeProfitTick], ['backfill', backfillTick], ['pnl', pnlTick]]) {
      try { await fn(); } catch (e) { log('ERR ' + name, String(e.message || e).slice(0, 200)); }
    }
  } finally { busy = false; }
}
await tick();
if (process.argv.includes('--once') || DRY) process.exit(0);
if (!on.length) log('没有打开任何任务，空转等待。改了配置要重启服务（npm run service install）才生效');
setInterval(tick, 60_000);
