// 成本自检的纯逻辑（不联网、不读写文件）：src/auto/cost-audit.mjs 调用，test/ 里有单元测试。
// 花费账 data/spend.jsonl 里付过 BNB、持仓（watch.json）里这个系列的成本却是空 / 0 的，按账上实际付出补上。
// 只补「空 / 0」的成本，已经有成本的不改（哪怕和账本对不上——可能是手动调过）。

// 花费账的行 → Map(`钱包id:合约(小写)` → 付过的 BNB 合计)。没有 wallet 字段的算主钱包
export function paidByWallet(lines, mainId) {
  const out = new Map();
  for (const l of lines || []) {
    let j; try { j = typeof l === 'string' ? JSON.parse(l) : l; } catch { continue; }
    const bnb = Number(j?.bnb);
    if (!(bnb > 0) || !Number.isFinite(bnb) || !/^0x[0-9a-fA-F]{40}$/.test(j.contract || '')) continue;
    const k = `${j.wallet || mainId}:${j.contract.toLowerCase()}`;
    out.set(k, (out.get(k) || 0) + bnb);
  }
  return out;
}
// 成本是否「有」：任何一个币种是大于 0 的数
export const hasCost = c => !!c && typeof c === 'object' && Object.values(c).some(v => typeof v === 'number' && Number.isFinite(v) && v > 0);

// 检查一个钱包的持仓：返回补记清单 [{ id, name, bnb }]，并直接改 watch（调用方负责写回）
export function auditWatch(watch, walletId, paid) {
  const fixed = [];
  for (const c of watch?.collections || []) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(c?.contract || '')) continue;
    const p = paid.get(`${walletId}:${c.contract.toLowerCase()}`);
    if (!(p > 0) || hasCost(c.cost)) continue;
    c.cost = { ...(c.cost && typeof c.cost === 'object' ? c.cost : {}), BNB: +p.toFixed(8) };
    fixed.push({ id: c.id, name: c.name || c.id, bnb: +p.toFixed(8) });
  }
  return fixed;
}
