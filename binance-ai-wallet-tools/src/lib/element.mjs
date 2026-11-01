// Element（BSC 上主要的 NFT 交易所）链上事件解析：纯函数，不联网。src/auto/market.mjs 和看板调用，test/ 里有单元测试。
// 只看链上真实发生的事：成交（卖单被买 / 买单被卖）、链上预签名求购（带出价和到期时间）、撤单。
// 挂卖单是链下签名，链上看不到，所以这里给不出「地板价」，只能说明「有没有人真的在买」。
import { keccak_256 } from '@noble/hashes/sha3';

export const ELEMENT = '0xb3e3dfcb2d9f3dde16d78b9e6eb3538eb32b5ae1';   // Element 交易所合约（BSC）
const topic = sig => '0x' + Buffer.from(keccak_256(Buffer.from(sig))).toString('hex');
const FILL = '(bytes32,address,address,uint256,address,uint256,(address,uint256)[],address,uint256)';
export const TOPICS = {
  sell: topic('ERC721SellOrderFilled' + FILL),     // 卖单被人买走
  buy: topic('ERC721BuyOrderFilled' + FILL),       // 求购被人卖给了
  cancel: topic('ERC721OrderCancelled(address,uint256)'),
  bid: '0x29806076879d6116f3a8b8f81980ee6273d4ae8cb3ede88be4bb96f88787c26c',   // 链上预签名求购（ERC721 买单）
};
const USDT = '55d398326f99059ff775485246999027b3197955';
const BNB_LIKE = new Set(['0'.repeat(40), 'e'.repeat(40), 'bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c']);   // 原生币 / 原生币占位 / WBNB

// 一条日志 → 事件，或 null（不是我们关心的系列、计价币不认识、格式不对）。
//   wanted：Set(小写 NFT 合约地址)，不传 = 都要
// 成交 / 求购：{ type: 'fill' | 'bid', nft, id, p（计价币数量）, cur: 'BNB' | 'USDT', key: 'maker:nonce', blk, exp?（求购到期，秒） }
// 撤单：{ type: 'cancel', key }。成交也会让 maker:nonce 作废（同一个求购单不能再用）
export function parseElementLog(l, wanted = null) {
  const t0 = l?.topics?.[0], W = String(l?.data || '').slice(2).match(/.{64}/g) || [];
  const ad = w => w.slice(24).toLowerCase(), n = w => BigInt('0x' + w);
  if (t0 === TOPICS.cancel) return W.length >= 2 ? { type: 'cancel', key: '0x' + ad(W[0]) + ':' + n(W[1]) } : null;
  const fill = t0 === TOPICS.sell || t0 === TOPICS.buy, bid = t0 === TOPICS.bid;
  if ((!fill && !bid) || W.length < 9) return null;
  // 字段位置：成交 [orderHash, maker, taker, nonce, erc20, amount, fees, nft, id]；求购 [maker, taker, expiry, nonce, erc20, amount, fees, nft, id]
  const maker = ad(fill ? W[1] : W[0]), nonce = n(W[3]), key = '0x' + maker + ':' + nonce;
  const nft = '0x' + ad(W[7]);
  if (wanted && !wanted.has(nft)) return fill ? { type: 'used', key } : null;
  const cur = ad(W[4]) === USDT ? 'USDT' : BNB_LIKE.has(ad(W[4])) ? 'BNB' : null;
  if (!cur) return fill ? { type: 'used', key } : null;
  const e = { type: fill ? 'fill' : 'bid', nft, id: String(n(W[8])), p: Number(n(W[5])) / 1e18, cur, key, blk: Number(l.blockNumber) };
  if (bid) e.exp = Number(n(W[2]) & 0xffffffffn);   // expiry 的高位还塞了挂单时间等信息，低 32 位才是到期时间（秒）
  return e;
}

// 存下来的事件统一成上面的格式（也认更早的写法：{ bid: 1, maker, nonce } 表示求购，没有 type 的是成交）
const norm = e => e && (e.type ? e : { ...e, type: e.bid ? 'bid' : 'fill', key: e.key || (e.maker ? e.maker + ':' + e.nonce : undefined) });
const normAll = events => (events || []).map(norm).filter(Boolean);

// 还有效的求购：没过期、没撤 / 没被用掉，而且只收「我们手上的编号」（多数求购单只收指定编号）
//   events：某个系列的事件列表；used：{ 'maker:nonce': 时间 }；ourIds：我们持有的编号（数组或 Set）；nowS：现在（秒）
export function liveBids(events, used, ourIds, nowS) {
  const mine = new Set([...(ourIds || [])].map(String));
  return normAll(events).filter(e => e.type === 'bid' && e.exp > nowS && !(used || {})[e.key] && mine.has(String(e.id)));
}
const usdOf = (e, bnbUsd) => e.cur === 'USDT' ? e.p : bnbUsd ? e.p * bnbUsd : null;

// 要不要报：近 3 天成交 ≥ minFills 笔且最近一笔 ≥ minFillUsd 美元；或有效求购（收我们的编号）≥ minBidUsd 美元。
// 返回 { hot, fills, last, bid, text } 或 null（不报）
export function marketVerdict(events, { used, ourIds, now = Date.now(), bnbUsd, minFills = 3, minFillUsd = 2, minBidUsd = 5 } = {}) {
  const fills = normAll(events).filter(e => e.type === 'fill' && now - e.ts < 3 * 86400_000).sort((a, b) => a.ts - b.ts);
  const bids = liveBids(events, used, ourIds, Math.floor(now / 1000)).map(e => ({ ...e, usd: usdOf(e, bnbUsd) })).filter(e => e.usd != null).sort((a, b) => b.usd - a.usd);
  const last = fills[fills.length - 1], lastUsd = last ? usdOf(last, bnbUsd) : null;
  const hot = fills.length >= minFills && lastUsd != null && lastUsd >= minFillUsd;
  const bid = bids[0] && bids[0].usd >= minBidUsd ? bids[0] : null;
  if (!hot && !bid) return null;
  const parts = [];
  if (hot) { const ps = fills.map(e => usdOf(e, bnbUsd)).filter(x => x != null).sort((a, b) => a - b); parts.push(`近 3 天成交 ${fills.length} 笔，最近一笔 $${lastUsd.toFixed(2)}（${last.p} ${last.cur}），区间 $${ps[0].toFixed(2)}–$${ps[ps.length - 1].toFixed(2)}`); }
  if (bid) parts.push(`有人求购我们的 #${bid.id}：$${bid.usd.toFixed(2)}（${bid.p} ${bid.cur}，${new Date(bid.exp * 1000).toISOString().slice(0, 10)} 到期）`);
  return { hot, fills: fills.length, last: last || null, bid, text: parts.join('；') };
}

// 给看板的摘要：近 7 天成交笔数、最近一笔、收我们编号的有效求购（每个编号取最高价，只算 BNB 计价的）
export function elementSummary(events, used, ourIds, now = Date.now()) {
  if (!events?.length) return null;
  const fills = normAll(events).filter(e => e.type === 'fill').sort((a, b) => a.ts - b.ts), last = fills[fills.length - 1];
  const best = {};
  for (const e of liveBids(events, used, ourIds, Math.floor(now / 1000))) if (e.cur === 'BNB' && (!best[e.id] || e.p > best[e.id])) best[e.id] = e.p;
  return { fills: fills.length, last: last ? { p: last.p, cur: last.cur, ts: last.ts } : null, bids: Object.keys(best).length, best };
}
