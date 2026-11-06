// 代币取价：DexScreener + GeckoTerminal 两边 BSC 的池子一起看，取流动性最大的那个池子的价格。
//   DexScreener 不收 Uniswap v4 / PancakeSwap Infinity 这类池子，只看它会把一些币看低很多；GeckoTerminal 收。
//   不取「最高价」：没人搬砖的小池子价格可以很离谱。
//   持仓估值另外封顶：最多按该池流动性的 30% 算（小池子砸不出账面价），见 capValue。
// 每个代币缓存 2 分钟；GeckoTerminal 免费接口约 30 次 / 分钟，请求之间至少隔 2.2 秒；它失败时只用 DexScreener，
// 结果标 partial: true，只缓存 30 秒。
// 纯函数（parseDexPairs / parseGtPools / pickBest / capValue）有单元测试。
import { isAddr } from './chain.mjs';

export const VALUE_CAP_SHARE = 0.3;
const TTL = 120_000, PARTIAL_TTL = 30_000, GT_GAP = 2200;

// DexScreener /latest/dex/tokens 的结果 → 池子列表
export function parseDexPairs(j) {
  return (j?.pairs || []).filter(x => x?.chainId === 'bsc' && +x.priceUsd > 0).map(p => ({
    price: +p.priceUsd, liquidity: +p.liquidity?.usd || 0, dex: String(p.dexId || ''), pool: isAddr(p.pairAddress) ? p.pairAddress : null,
    url: /^https:\/\/dexscreener\.com\//.test(p.url || '') ? p.url : null, src: 'dexscreener' }));
}
// GeckoTerminal /networks/bsc/tokens/<token>/pools 的结果 → 池子列表。我们的币可能是 base 也可能是 quote，两边都不是的池子丢掉
export function parseGtPools(j, token) {
  const t = String(token).toLowerCase(), out = [];
  for (const p of j?.data || []) {
    const a = p?.attributes || {}, r = p?.relationships || {};
    const base = String(r.base_token?.data?.id || '').toLowerCase(), quote = String(r.quote_token?.data?.id || '').toLowerCase();
    const price = base.endsWith(t) ? +a.base_token_price_usd : quote.endsWith(t) ? +a.quote_token_price_usd : NaN;
    if (!(price > 0) || !Number.isFinite(price)) continue;
    const pool = /^0x[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/.test(a.address || '') ? a.address : null;   // v4 / Infinity 的池子是 32 字节的 id
    out.push({ price, liquidity: +a.reserve_in_usd || 0, dex: String(r.dex?.data?.id || ''), pool, url: pool ? `https://www.geckoterminal.com/bsc/pools/${pool}` : null, src: 'geckoterminal' });
  }
  return out;
}
// 流动性最大的池子；一个都没有返回 null
export const pickBest = pools => [...(pools || [])].filter(p => p && p.price > 0).sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0))[0] || null;
// 持仓估值：数量 × 价格，但不超过该池流动性的 30%（流动性未知时不封顶）
export const capValue = (qty, q) => {
  if (!q || !(q.price > 0)) return 0;
  const v = qty * q.price;
  return q.liquidity > 0 ? Math.min(v, q.liquidity * VALUE_CAP_SHARE) : v;
};

// ---------- 联网 ----------
const cache = new Map();
let gtNext = 0;
async function gtSlot() { const now = Date.now(), at = Math.max(now, gtNext); gtNext = at + GT_GAP; if (at > now) await new Promise(r => setTimeout(r, at - now)); }
async function fromDex(token) {
  const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + token, { signal: AbortSignal.timeout(20000) });
  return parseDexPairs(await r.json());
}
async function fromGecko(token) {
  await gtSlot();
  const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${token}/pools?page=1`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) { r.body?.cancel().catch(() => {}); throw new Error('geckoterminal ' + r.status); }
  return parseGtPools(await r.json(), token);
}
// → { price, liquidity, dex, pool, url, src, partial } 或 null（哪边都没有池子 = 还没开盘）
export async function bestPrice(token) {
  if (!isAddr(token)) return null;
  const k = token.toLowerCase(), c = cache.get(k);
  if (c && Date.now() - c.at < c.ttl) return c.v;
  let gtFail = false;
  const [a, b] = await Promise.all([fromDex(k).catch(() => []), fromGecko(k).catch(() => { gtFail = true; return []; })]);
  const best = pickBest([...a, ...b]);
  const v = best ? { ...best, partial: gtFail } : null;
  cache.set(k, { at: Date.now(), ttl: gtFail ? PARTIAL_TTL : TTL, v });
  return v;
}

// ---------- 批量问 DexScreener 有没有池子（止盈用：几百个还没开盘的免费币，逐个问一轮要好几分钟） ----------
export const DEX_BATCH = 30;
// DexScreener /latest/dex/tokens/a,b,c 的结果 → 有池子（BSC、有价格）的代币（小写地址）
export function parseDexOpen(j, tokens) {
  const want = new Set((tokens || []).map(t => String(t).toLowerCase())), open = new Set();
  for (const p of j?.pairs || []) {
    if (p?.chainId !== 'bsc' || !(+p.priceUsd > 0)) continue;
    for (const a of [p.baseToken?.address, p.quoteToken?.address]) { const k = String(a || '').toLowerCase(); if (want.has(k)) open.add(k); }
  }
  return open;
}
// → Set（有池子的代币）；任何一批失败返回 null（调用方退回逐个查）
export async function dexOpenBatch(tokens) {
  const L = [...new Set((tokens || []).filter(isAddr).map(t => t.toLowerCase()))], open = new Set();
  try {
    for (let i = 0; i < L.length; i += DEX_BATCH) {
      const part = L.slice(i, i + DEX_BATCH);
      const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + part.join(','), { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('dexscreener ' + r.status);
      for (const a of parseDexOpen(await r.json(), part)) open.add(a);
    }
    return open;
  } catch { return null; }
}
