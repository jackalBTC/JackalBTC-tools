#!/usr/bin/env node
// 手动补领：某个钱包掉线期间，别的钱包领过的免费项目给它补一遍。会发交易（只做零付费、零授权、零风险提示的）。
// 用法: npm run backfill -- <钱包id> [起始时间] [--dry]
//   起始时间：ISO 时间或日期，例如 2026-11-01；不写 = 最近 3 天
//   --dry   只模拟，不预演不执行、不写状态
// 规则和把关见 src/auto/backfill.mjs、src/lib/missed.mjs。
import { getWallet } from '../lib/wallets.mjs';

const USAGE = '用法: npm run backfill -- <钱包id> [起始时间，例如 2026-11-01] [--dry]';
const argv = process.argv.slice(2), pos = [];
for (const a of argv) {
  if (a === '--dry') continue;
  if (a.startsWith('-')) { console.error(`不认识的参数 ${a}\n${USAGE}`); process.exit(1); }
  pos.push(a);
}
if (!pos.length || pos.length > 2) { console.error(USAGE); process.exit(1); }
const since = pos[1] ? Date.parse(pos[1]) : Date.now() - 3 * 86400_000;
if (!Number.isFinite(since)) { console.error('起始时间看不懂：' + pos[1] + '\n' + USAGE); process.exit(1); }
let w;
try { w = await getWallet(pos[0]); } catch (e) { console.error(e.message); process.exit(1); }
const { backfillWallet } = await import('../auto/backfill.mjs');   // common.mjs 读 --dry
const r = await backfillWallet(w, since);
console.log(JSON.stringify(r));
process.exit(0);
