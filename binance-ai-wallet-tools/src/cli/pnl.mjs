#!/usr/bin/env node
// 钱包整体盈亏（只读）：npm run pnl [-- --dry]
//   每个钱包：本金（转进来的）/ 转出给你的 / 现在余额 / 加回项 / 净盈亏，按项目明细；结果写 data/pnl.json，看板「盈亏」页显示。
//   --dry 只算不写文件。口径见 src/lib/pnl.mjs，配置见 config.pnl（docs/auto.md「钱包整体盈亏」）。
import { runPnl } from '../auto/pnl.mjs';

for (const a of process.argv.slice(2)) if (a !== '--dry') { console.error(`不认识的参数 ${a}\n用法: npm run pnl [-- --dry]`); process.exit(1); }
try {
  const r = await runPnl();
  for (const w of r.wallets) {
    const s = w.sum || {};
    console.log(`${String(w.label || w.id).padEnd(12)} 本金 $${s.in}  转出 $${s.out}  现在 $${s.balance}  加回 $${s.added}  净盈亏 ${s.pnl >= 0 ? '+' : ''}$${s.pnl}${w.stale ? '（没刷新到，沿用上一次）' : ''}  核对 ${w.check?.expect} ≈ ${w.check?.actual}`);
  }
  console.log(`合计 ${r.total >= 0 ? '+' : ''}$${r.total}（BNB 按 $${r.bnbUsd}）`);
  process.exit(0);
} catch (e) { console.error('算不了：' + e.message); process.exit(1); }
