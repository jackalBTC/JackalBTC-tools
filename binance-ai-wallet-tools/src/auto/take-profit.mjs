// 自动止盈（默认关：config.auto.takeProfit.enabled）。会卖币，打开前读 docs/auto.md。
// 盯每个钱包 watch.json 的 tokens：现价（DexScreener + GeckoTerminal 里流动性最大的池子，src/lib/price.mjs）÷ 平均成本价 = 倍数，按 src/lib/takeprofit.mjs 的阶梯卖出。
// 只卖 watch.json 里登记的代币，只换回 BNB（baw market-order swap），从不买入、不授权、不转账。
// 平均成本价 = 成本（cost，美元 / BNB 折美元）÷ 第一次看到时的持仓数量。没写成本的代币不卖。
// 成本绝不记成 0 / NaN：BNB 价格读不到就用上一次读到的（存在状态的 _bnbUsd），也没有就整轮跳过；成本没定下来的每轮重算。
// 免费领的代币（watch.json 里 free: true，没有成本）：开盘（第一次有报价）先卖一半，剩下的以开盘价当成本照常走阶梯；
//   还没开盘的先批量问 DexScreener，没池子的每个币约 1 小时才补查一次 GeckoTerminal（几百个免费币一轮也只要几十秒）。
// 币安把代币标了风险、需要在 App 里确认（错误 30003001）时：不重试，发一条「重要」动态请你去 App 确认，然后在成交记录里等它成交再记账。
import { config, readJson, writeJson } from '../lib/config.mjs';
import { baw, rpc, bnbUsd, tokenBalance, fmtUnits } from '../lib/chain.mjs';
import { bestPrice, dexOpenBatch } from '../lib/price.mjs';
import { listWallets, envFor, sessionOk, readWatch } from '../lib/wallets.mjs';
import { pickStage, stageName, costToUsd, usableBnbUsd, unopenedFree, skipUnopened, nextProbe } from '../lib/takeprofit.mjs';
import { log, addNews, event, withLock, DRY } from './common.mjs';

const BNB = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';   // baw 里原生 BNB 的写法
const NEEDS_APP = 30003001;
let at = 0;

async function sell(w, t, s, pick, dec, q) {
  const qty = fmtUnits(pick.amount, dec);
  if (DRY) { log('[试运行] SELL', w.id, t.symbol, pick.stage, qty, `现价是成本的 ${q.mult.toFixed(2)} 倍`); return; }
  const r = await withLock(async () => {
    const se = await sessionOk(w); if (se) return { error: { message: se } };
    return baw(['market-order', 'swap', '--fromTokenQty', qty, '--fromToken', t.contract, '--toToken', BNB, '--binanceChainId', String(config.chainId), '--slippage', String(config.auto.takeProfit.slippage)], envFor(w), 120_000);
  });
  if (!r) return;   // 有 mint 在跑，下一轮
  if (r.success && r.data?.orderId) { s.pending = { stage: pick.stage, orderId: r.data.orderId, qty, at: Date.now() }; log('ORDER', w.id, t.symbol, pick.stage, qty, r.data.orderId); return; }
  const code = Number(r.error?.code), msg = String(r.error?.message || '');
  if (code === NEEDS_APP || /flagged as potentially risky/i.test(msg)) {
    s.pending = { stage: pick.stage, orderId: null, qty, at: Date.now(), needsApp: true };
    addNews(t.id, '重要', `${t.symbol || t.name} 到了止盈点：请在币安 App 里确认卖出`,
      `${w.label || w.id} 钱包的 ${t.symbol || t.name} 现在是买入价的 ${q.mult.toFixed(2)} 倍（现价 $${q.price.toPrecision(4)}），按规则「${pick.name}」要卖出 ${Number(qty).toLocaleString('en-US')} 枚换回 BNB。币安把这个币标了风险，需要你打开 App（这个钱包对应的账号）→ AI 钱包，确认这笔卖出。`);
    log('NEEDS_APP', w.id, t.symbol, pick.stage, qty); return;
  }
  s.errors = (s.errors || 0) + 1;
  log('ERR sell', w.id, t.symbol, pick.stage, code || '', msg.slice(0, 160));
  if (s.errors === 3) addNews(t.id, '重要', `${t.symbol || t.name} 止盈卖出失败`, `${w.label || w.id} 钱包按「${pick.name}」卖出连续失败 3 次：${msg.slice(0, 120)}。请看一下。`);
}

async function settle(w, t, s, px) {   // 挂起的卖单：成交了就记账，失败 / 取消就放掉，6 小时都没结果也放掉
  const p = s.pending; if (!p) return;
  const r = await baw(['market-order', 'list', ...(p.orderId ? ['--orderId', String(p.orderId)] : [])], envFor(w));
  const list = r?.data?.list || r?.data?.orders || (Array.isArray(r?.data) ? r.data : []);
  const o = list.find(x => p.orderId ? String(x.orderId) === String(p.orderId) : String(x.fromToken || '').toLowerCase() === t.contract.toLowerCase() && Date.parse(x.bookTime) >= p.at - 60_000 && x.status === 'FINISHED');
  if (!o) { if (Date.now() - p.at > 6 * 3600_000) { log('GIVEUP pending', w.id, t.symbol, p.stage); s.pending = null; } return; }
  if (o.status === 'FINISHED') {
    const sold = Number(o.fromTokenQty), got = Number(o.toTokenActualQty);
    s.done[p.stage] = new Date().toISOString(); s.pending = null; s.errors = 0;
    const name = stageName(p.stage, t), costPart = t.free === true ? 0 : s.origAmount ? s.costUsd * sold / s.origAmount : 0;   // 免费币的「成本」是开盘价，只用来算倍数，不记进盈亏
    const tx = /^0x[0-9a-fA-F]{64}$/.test(o.txHash || '') ? o.txHash : null;
    const R = readJson('realized.json', []);
    R.push({ ts: new Date().toISOString().slice(0, 10), project: t.id, name: `${t.symbol || t.name} 止盈：${name}（${Math.round(sold).toLocaleString('en-US')} 枚）`,
      cost: { USDT: +costPart.toFixed(4) }, proceeds: { BNB: +got.toFixed(8) }, qty: sold, ...(tx ? { tx } : {}), ...(w.main ? {} : { wallet: w.id }) });
    writeJson('realized.json', R);
    if (tx) event(t.id, 'execute', `止盈「${name}」：卖出 ${sold} ${t.symbol || ''} → ${got} BNB`, { tx, contract: t.contract }, w);
    addNews(t.id, '机会', `${t.symbol || t.name} 止盈卖出成交`, `${w.label || w.id} 钱包按「${name}」卖出 ${Math.round(sold).toLocaleString('en-US')} 枚，换回 ${got.toFixed(5)} BNB（约 $${(got * px).toFixed(2)}）。`);
    log('FILLED', w.id, t.symbol, p.stage, sold, '->', got, 'BNB');
  } else if (['FAILED', 'CANCELED', 'CANCELLED', 'EXPIRED'].includes(o.status)) {
    log('ORDER', o.status, w.id, t.symbol, p.stage); s.pending = null; s.errors = (s.errors || 0) + 1;
  }
}

export async function takeProfitTick() {
  const T = config.auto?.takeProfit;
  if (!T?.enabled || Date.now() - at < T.everyMinutes * 60_000) return;
  at = Date.now();
  const st = readJson('take-profit-state.json', {});
  const px = usableBnbUsd(await bnbUsd().catch(() => NaN), st._bnbUsd);
  if (!px) { log('SKIP 读不到 BNB 价格，也没有上一次的价格，这轮不动'); return; }
  st._bnbUsd = px;
  const WS = await listWallets(), now = Date.now();
  const unopened = [];
  for (const w of WS) for (const t of readWatch(w).tokens || []) if (/^0x[0-9a-fA-F]{40}$/.test(t.contract || '') && unopenedFree(t, st[`${w.id}:${t.id}`])) unopened.push(t.contract);
  const OPEN = unopened.length ? await dexOpenBatch(unopened) : new Set();
  for (const w of WS) {
    let gas = null;
    for (const t of readWatch(w).tokens || []) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(t.contract || '') || !/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(t.id || '')) continue;
      const key = `${w.id}:${t.id}`, s = st[key] ||= { done: {} };
      if (skipUnopened(t, s, OPEN, now)) continue;   // 免费币没开盘、还没到补查时间：这轮连余额都不查
      try {
        const bal = await tokenBalance(t.contract, w.address);
        if (s.origAmount == null) {   // 第一次见：定下原始持仓和成本（美元）
          if (bal.raw === 0n) continue;
          s.origAmount = Number(bal.raw) / 10 ** bal.decimals;
          s.costUsd = t.free === true ? null : costToUsd(t.cost, px);
        }
        if (t.free !== true && !(s.costUsd > 0)) { s.costUsd = costToUsd(t.cost, px); if (!s.costUsd) { s.costUsd = null; continue; } }   // 没写成本 / 以前记坏了：每轮重算，算不出不卖
        await settle(w, t, s, px);
        if (s.pending) continue;
        if (unopenedFree(t, s)) s.probeAt = nextProbe();
        const d = await bestPrice(t.contract).catch(() => null); if (!d) continue;   // 还没开盘
        if (unopenedFree(t, s)) {   // 免费币第一次有报价 = 开盘：开盘价当成本（只用来算倍数）
          s.openPx = d.price; s.openAt = new Date().toISOString(); s.costUsd = d.price * s.origAmount;
          log('OPEN', key, t.symbol, '开盘价', d.price);
        }
        const q = { price: d.price, mult: d.price / (s.costUsd / s.origAmount) };
        s.peak = Math.max(s.peak || 0, q.mult); s.last = { price: q.price, mult: +q.mult.toFixed(3), at: new Date().toISOString() };
        const pick = pickStage(t, s, { mult: q.mult, price: q.price, raw: bal.raw, decimals: bal.decimals }, { freeMinUsd: T.freeMinUsd ?? undefined });
        if (!pick) continue;
        gas ??= Number(BigInt(await rpc('eth_getBalance', [w.address, 'latest']))) / 1e18;
        if (gas < config.spending.minBnbForTx) { log('SKIP gas 不够', key, gas.toFixed(5)); continue; }
        await sell(w, t, s, pick, bal.decimals, q);
      } catch (e) { log('ERR', key, e.message); }
    }
  }
  if (!DRY) writeJson('take-profit-state.json', st);
}
