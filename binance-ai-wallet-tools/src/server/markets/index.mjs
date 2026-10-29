// 市场适配器：给持仓卡片算地板价 / 在挂数量 / 按稀有度的地板价。
// watch.json 里每个系列的 market 字段决定用哪个：
//   { "type": "none" }                                   还没有市场
//   { "type": "link", "url": "https://…" }               外部市场（只放链接，不读价格）
//   { "type": "listing-scan", … }                        通用：按 tokenId 逐个读市场合约的挂单（见 docs/markets.md）
// 想接入新的市场：在这里加一个 type，导出 async (market, collection, ctx) => ({ floor, listed, byRarity?, note? })。
import { batch, sel, word, big } from '../../lib/chain.mjs';

export function byRarity(listings) {   // [{ rarity, price }] → { rarity: { floor, listed } }
  const out = {};
  for (const l of listings) { const o = out[l.rarity || '未知'] ||= { floor: null, listed: 0 }; o.listed++; if (o.floor === null || l.price < o.floor) o.floor = l.price; }
  return out;
}

// 通用挂单扫描。参数（都写在 watch.json 的 market 里）：
//   contract      市场合约
//   currency      计价币显示名，例如 "USDT" / "BNB"
//   decimals      计价币小数位，默认 18
//   activeFn      可选：判断是否在挂的函数，例如 "isActive(uint256)"、"listingLive(uint256)"；返回非 0 即在挂
//   listingFn     读挂单的函数，例如 "listings(uint256)"、"getListing(uint256)"
//   priceWord     价格在返回值里是第几个 32 字节字（从 0 开始）
//   activeWord    可选：没有 activeFn 时，用返回值里第几个字判断在挂（非 0 即在挂）
//   supplyFn      可选：遍历 tokenId 的上限，默认 "totalSupply()"
async function listingScan(m, col, ctx) {
  const [t] = await batch([[col.contract, '0x' + sel(m.supplyFn || 'totalSupply()')]]);
  const total = Number(big(t)), dec = 10 ** (m.decimals ?? 18), L = [];
  if (!total) return { floor: null, listed: 0, note: '读不到总量' };
  for (let i = 1; i <= total; i += 20) {
    const ids = []; for (let j = i; j < i + 20 && j <= total; j++) ids.push(j);
    let live = ids;
    if (m.activeFn) {
      const act = await batch(ids.map(id => [m.contract, '0x' + sel(m.activeFn) + word(id)]));
      live = ids.filter((_, k) => big(act[k]) !== 0n);
      if (!live.length) continue;
    }
    const ls = await batch(live.map(id => [m.contract, '0x' + sel(m.listingFn) + word(id)]));
    ls.forEach((h, k) => {
      const w = (h || '').slice(2).match(/.{64}/g) || [];
      if (m.activeWord != null && (!w[m.activeWord] || BigInt('0x' + w[m.activeWord]) === 0n)) return;
      const raw = w[m.priceWord ?? 1]; if (!raw) return;
      const price = Number(BigInt('0x' + raw)) / dec;
      if (price > 0) L.push({ id: live[k], price });
    });
  }
  if (ctx?.rarityOf) for (const x of L) x.rarity = await ctx.rarityOf(x.id).catch(() => null);
  return { floor: L.length ? Math.min(...L.map(x => x.price)) : null, listed: L.length, byRarity: L.some(x => x.rarity) ? byRarity(L) : undefined };
}

export const ADAPTERS = { 'listing-scan': listingScan };
