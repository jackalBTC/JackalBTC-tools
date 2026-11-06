// 自动止盈的阶段选择：纯函数，不联网。src/auto/take-profit.mjs 调用，test/ 里有单元测试。
// 默认规则（倍数 = 现价 ÷ 平均成本价）：
//   3 倍：卖出相当于本钱的那部分（回本）；
//   10 / 30 / 50 / 100 / 150 / 200 倍：各卖「剩余」的 20%；一轮只走一档，从低到高；
//   10 倍那档卖过之后又跌回 3 倍以下：卖剩余的一半（只一次）。
// 每个阶段只执行一次（记在状态的 done 里）。
// watch.json 里单个代币可以覆盖：
//   firstTp: { mult, frac }   代替 3 倍那一档：到 mult 倍先卖 frac（0–1）的持仓，之后照常走阶梯
//   ladder: [20, 50, …]       自定「各卖剩余 20%」的倍数
//   back3: false              不做「跌回 3 倍卖一半」
//   hold: true                完全不自动卖，只记价格
//   sellOnce: 0.5             有报价就卖这个比例一次，之后不再自动卖（不走上面任何一档）
//   free: true                免费领的代币（没有成本）：开盘（第一次有报价）先卖一半；剩下的以开盘价当成本，照常走 10 / 30 / … 倍和「跌回 3 倍」。
//                             一半不值 freeMinUsd 美元（默认 0.3，不够 gas）就先不卖，等涨上来

export const LADDER = [10, 30, 50, 100, 150, 200];
export const FREE_MIN_USD = 0.3;

const validFirst = t => t?.firstTp && +t.firstTp.mult > 1 && +t.firstTp.frac > 0 && +t.firstTp.frac <= 1 ? { mult: +t.firstTp.mult, frac: +t.firstTp.frac } : null;
export const ladderOf = t => { const l = Array.isArray(t?.ladder) ? t.ladder.map(Number).filter(x => Number.isFinite(x) && x > 1).sort((a, b) => a - b) : []; return l.length ? l : LADDER; };
const frac = (raw, f) => raw * BigInt(Math.round(f * 1000)) / 1000n;   // 按千分比取整，避免浮点

// 阶段的中文说明（推送、台账里用）
export function stageName(stage, t = {}) {
  if (stage === 'once') return `一次性卖出 ${Math.round(+t.sellOnce * 100)}%`;
  if (stage === 'tp3' && !validFirst(t)) return '3 倍卖回本钱';
  if (stage === 'back3') return '到过 10 倍后跌回 3 倍，卖剩余的一半';
  if (stage === 'open') return '免费领的币开盘，先卖一半';
  const f = validFirst(t);
  if (f && stage === 'tp' + f.mult) return `${f.mult} 倍先卖 ${Math.round(f.frac * 100)}%`;
  const m = /^tp(\d+(?:\.\d+)?)$/.exec(stage);
  return m ? `${m[1]} 倍卖剩余的 20%` : stage;
}

// 选这一轮要执行的阶段。
//   t：watch.json 里的代币条目；s：状态 { done: {阶段: 时间}, costUsd }
//   q：{ mult 现价是成本的几倍, price 现价（美元）, raw 当前持仓（最小单位 BigInt）, decimals }
//   opt：{ freeMinUsd }（免费币开盘那一半至少值多少美元才卖）
// 返回 { stage, amount(BigInt), name } 或 null（这一轮不卖）
export function pickStage(t, s, { mult, price, raw, decimals }, { freeMinUsd = FREE_MIN_USD } = {}) {
  const done = s?.done || {};
  raw = BigInt(raw || 0);
  if (!t || t.hold === true || raw <= 0n || !(mult > 0)) return null;
  const out = (stage, amount) => amount > 0n ? { stage, amount: amount > raw ? raw : amount, name: stageName(stage, t) } : null;
  if (t.sellOnce != null) {   // 只卖一次：设了就不走任何阶梯
    const f = +t.sellOnce;
    if (!(f > 0 && f <= 1) || done.once) return null;
    return out('once', frac(raw, f));
  }
  if (t.free === true && !done.open) {   // 免费币开盘先卖一半（一半不值 freeMinUsd 就等）
    const half = raw / 2n, usd = Number(half) / 10 ** (decimals ?? 18) * price;
    return price > 0 && usd >= freeMinUsd ? out('open', half) : null;
  }
  const first = validFirst(t), firstKey = first && 'tp' + first.mult, lad = ladderOf(t);
  if (t.back3 !== false && done.tp10 && !done.back3 && mult <= 3) return out('back3', raw / 2n);
  const opened = first ? done[firstKey] : (done.tp3 || done.open);   // 回本那一档（免费币：开盘那一半）做过了才走阶梯
  const next = opened && lad.find(x => mult >= x && !done['tp' + x]);
  if (next) return out('tp' + next, raw / 5n);
  if (first) return mult >= first.mult && !done[firstKey] ? out(firstKey, frac(raw, first.frac)) : null;
  if (t.free !== true && mult >= 3 && !done.tp3) {   // 卖出相当于本钱的数量：成本（美元）÷ 现价
    if (!(s?.costUsd > 0) || !(price > 0)) return null;
    const want = BigInt(Math.floor(s.costUsd / price * 1e6)) * 10n ** BigInt(decimals ?? 18) / 1000000n;
    return out('tp3', want);
  }
  return null;
}

// 成本（watch.json 的 cost：{ USDT / USD / BNB: 数量 }）折成美元；读不出返回 null
export function costToUsd(cost, bnbUsd) {
  if (!cost || typeof cost !== 'object') return null;
  const v = (+cost.USDT || 0) + (+cost.USD || 0) + (cost.BNB ? (bnbUsd ? +cost.BNB * bnbUsd : NaN) : 0);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// 这一轮用的 BNB 价格：读到的有效就用它，读不到（NaN / 0）用上一次存下的，都没有返回 null（这一轮不动）
export const usableBnbUsd = (fresh, last) => fresh > 0 && Number.isFinite(fresh) ? fresh : last > 0 && Number.isFinite(last) ? last : null;

// 还没开盘的免费币：每轮先批量问 DexScreener（一次 30 个）有没有池子；没池子的，GeckoTerminal 每个币约 1 小时才补查一次（错开时间，免得一起到期）。
//   open：这一轮批量查到有池子的代币（小写地址的 Set）；null = 批量查失败（退回逐个查）
//   返回 true = 这一轮跳过这个代币（连余额都不查）
export const unopenedFree = (t, s) => t?.free === true && !(s?.costUsd > 0);
export function skipUnopened(t, s, open, now = Date.now()) {
  if (!unopenedFree(t, s) || !open || s?.origAmount == null || s?.pending) return false;
  if (open.has(String(t.contract).toLowerCase())) return false;
  return now < (s.probeAt || 0);
}
// 下次补查 GeckoTerminal 的时间：45–75 分钟后（rand 0–1）
export const nextProbe = (now = Date.now(), rand = Math.random()) => now + (45 + rand * 30) * 60_000;
