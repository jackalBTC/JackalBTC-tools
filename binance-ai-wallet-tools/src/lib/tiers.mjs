// 看板「持仓与市场」的分组和已实现盈亏汇总：纯函数，不联网。server.mjs 调用，test/ 里有单元测试。
// 分组（按顺序判断，先中先得）：
//   dead   已核销：watch.json 里标了 writtenOff（确认归零，成本全额计亏损）
//   exit   已清仓：一张 / 一枚都不剩了，卡片只显示账本结果（累计成本 / 累计收回 / 净盈亏）
//   open   能卖：真有报价（地板价、最高求购、DEX 现价，或估值 > 0）
//   nobid  有市场没买家：Element 上有成交但没人收我们的编号，或配了市场但没有挂单 / 报价（DEX 代币不算，没池子就是没开盘）
//   new    新打的：24 小时内打的，或 48 小时内有项目动态（不知道哪天打的也算新）
//   idle   沉寂：其余。一有报价或新动态就自动回到上面的分组
export const TIERS = ['open', 'nobid', 'new', 'idle', 'exit', 'dead'];
const D = 86400_000;
export const priced = p => p.value > 0 || p.floor != null || p.bid != null;

export function tierOf(p, now = Date.now()) {
  if (p.writtenOff) return 'dead';
  if (p.held === 0) return 'exit';
  if (priced(p)) return 'open';
  if (p.el?.fills || (p.marketType && p.marketType !== 'none' && p.marketType !== 'dex')) return 'nobid';
  if (!p.firstMint || now - p.firstMint < D || (p.lastNews && now - p.lastNews < 2 * D)) return 'new';
  return 'idle';
}

// 成本 / 收回 { 币种: 数量 } 相加
export function sumCost(a, b) {
  if (!b) return a ? { ...a } : null;
  const o = { ...(a || {}) };
  for (const [k, v] of Object.entries(b)) o[k] = +((o[k] || 0) + (Number(v) || 0)).toFixed(10);
  return o;
}
// realized.json 里某个项目在某个钱包的卖出记录合计。没有 wallet 字段的记录算主钱包；walletId 传 null = 所有钱包
export function realizedOf(list, project, walletId = null, mainId = 'main') {
  const r = (list || []).filter(x => x && x.project === project && (walletId == null || String(x.wallet || mainId).toLowerCase() === String(walletId).toLowerCase()));
  if (!r.length) return null;
  return { n: r.length, cost: r.reduce((a, x) => sumCost(a, x.cost), null), proceeds: r.reduce((a, x) => sumCost(a, x.proceeds), null), qty: r.reduce((a, x) => a + (Number(x.qty) || 0), 0) };
}
