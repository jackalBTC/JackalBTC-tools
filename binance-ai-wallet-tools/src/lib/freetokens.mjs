// 免费领到的代币登记进止盈名单：纯函数，不联网。src/cli/pnl.mjs 调用，test/ 里有单元测试。
// 只认「自己发起、这笔交易没花 BNB / USDT」收到的代币（= 免费领的）：
//   - 跳过 transfer / swap / sale：别人空投来的可能是钓鱼币，买卖来的有成本；
//   - 跳过 BNB / USDT / WBNB 本身和没有小数位的（NFT）；
//   - 同一个代币只要有一次是花钱换来的，就不算免费（列出来给你看，不自动登记）。
const lc = a => String(a || '').toLowerCase();
const BASE = new Set(['BNB', 'USDT', 'WBNB']);
const SKIP_TYPES = new Set(['transfer', 'swap', 'sale']);

// → Map(代币地址 → { sym, free })
export function tokensFromHistory(history) {
  const got = new Map();
  for (const t of history || []) {
    if (t?.status !== 'confirmed' || SKIP_TYPES.has(t.txType)) continue;
    for (const h of t.txHashList || []) {
      const spent = (h.instructions?.send || []).some(x => BASE.has(x.tokenInfo?.symbol) && Number(x.amount) > 0);
      for (const x of h.instructions?.receive || []) {
        const ti = x.tokenInfo || {};
        if (BASE.has(ti.symbol) || !(ti.decimals > 0) || !/^0x[0-9a-fA-F]{40}$/.test(ti.contractAddress || '')) continue;
        const a = lc(ti.contractAddress), g = got.get(a) || { sym: String(ti.symbol || 'TOKEN'), free: true };
        if (spent) g.free = false;
        got.set(a, g);
      }
    }
  }
  return got;
}

// watch.json 里的 id：符号的字母数字（最多 20 个）+ 地址前 4 位，和已有的不重复
export function tokenId(sym, addr, used = new Set()) {
  let id = (String(sym || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'tok') + '-' + lc(addr).slice(2, 6);
  while (used.has(id)) id += 'x';
  return id;
}

// 要登记的：不在 watch.json 里、不在跳过名单里、链上确实还持有 ≥ 1 枚、不是 NFT
//   onchain(addr) → { raw: BigInt, decimals: number, nft: boolean }（由调用方查链）
export async function planFreeTokens(got, { have = new Set(), skip = new Set(), onchain }) {
  const add = [], paid = [];
  for (const [a, g] of got) {
    if (have.has(a) || skip.has(a)) continue;
    const c = await onchain(a);
    if (!c || !(c.raw > 0n) || c.nft) continue;
    if (c.decimals <= 36 && c.raw < 10n ** BigInt(c.decimals)) continue;   // 不到 1 枚的零头（卖剩的灰尘）
    if (g.free) add.push({ contract: a, sym: g.sym }); else paid.push({ contract: a, sym: g.sym });
  }
  return { add, paid };
}
