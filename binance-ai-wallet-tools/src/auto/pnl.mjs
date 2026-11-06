// 钱包整体盈亏（只读，不发交易）：拉每个钱包的交易历史 → 认出资金进出 → 按项目归类 → 写 data/pnl.json（看板「盈亏」页读它）。
// 算法和口径见 src/lib/pnl.mjs。手动跑：npm run pnl；后台：config.pnl.auto = true 时每 everyHours 小时跑一次。
//   缓存在 data/pnl-cache/（交易历史增量拉取；中途没拉完不写缓存；某个钱包拉不到就沿用上一次的结果并标 stale）。
//   顺便把「免费领到的代币」登记进止盈名单（config.pnl.registerFreeTokens，默认开；只写 watch.json，不发交易），规则见 src/lib/freetokens.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { config, readJson, writeJson, dataFile } from '../lib/config.mjs';
import { rpc, batch, sel, word, big, baw } from '../lib/chain.mjs';
import { listWallets, envFor, readWatch, writeWatch } from '../lib/wallets.mjs';
import { movesOf, looksLikeExchange, makeNamer, walletPnl, mergePage, klinesToDaily, dayOf, TRANSFER_TYPES, BASE, USDT } from '../lib/pnl.mjs';
import { tokensFromHistory, tokenId, planFreeTokens } from '../lib/freetokens.mjs';
import { log, DRY } from './common.mjs';

const CDIR = dataFile('pnl-cache');
const C = n => path.join(CDIR, n);
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const wj = (f, v) => { if (DRY) return; fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
const lc = a => String(a || '').toLowerCase();
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); }

// 交易历史（增量）。拉不全就抛错，调用方沿用上一次结果
async function history(w) {
  const f = C(`hist-${w.id}.json`), old = rj(f, []), seen = new Set(old.map(t => t.txHashList?.[0]?.txHash));
  const fresh = [], since = config.pnl?.since ? Date.parse(config.pnl.since) : null;
  let cur = null;
  for (let i = 0; i < 300; i++) {
    const j = await baw(['wallet', 'tx-history', '--size', '100', ...(since ? ['--startTime', String(since)] : []), ...(cur ? ['--nextCursor', cur] : [])], envFor(w), 120_000);
    if (!j?.success) throw new Error(`${w.id} 交易历史拉不到（${j?.error?.message || '未登录？'}）`);
    const r = mergePage(j.data, seen, fresh);
    if (r.stop) { if (!r.done) break; const all = [...fresh, ...old]; wj(f, all); return all; }
    cur = r.cursor;
  }
  throw new Error(`${w.id} 交易历史中途没拉完，这次沿用上一次结果`);
}
// 转账类交易：上链读对方地址；只有 BNB / USDT 进出的交易：读被调用的合约（用来归到项目）
async function enrich(w, H) {
  const me = lc(w.address), fCp = C(`cp-${w.id}.json`), fTo = C(`to-${w.id}.json`), CP = rj(fCp, {}), TO = rj(fTo, {});
  const jobsCp = [], jobsTo = [];
  for (const t of H) for (const h of t.txHashList || []) {
    if (TRANSFER_TYPES.includes(t.txType) && !CP[h.txHash]) jobsCp.push(h.txHash);
    const all = [...(h.instructions?.send || []), ...(h.instructions?.receive || [])];
    if (!all.some(x => !BASE.has(x.tokenInfo?.symbol)) && TO[h.txHash] === undefined) jobsTo.push(h.txHash);
  }
  await pool(jobsCp, 6, async h => {
    const [tx, rc] = await Promise.all([rpc('eth_getTransactionByHash', [h]).catch(() => null), rpc('eth_getTransactionReceipt', [h]).catch(() => null)]);
    const mv = movesOf(tx, rc, me); if (mv) CP[h] = mv;
  });
  await pool(jobsTo, 6, async h => { const tx = await rpc('eth_getTransactionByHash', [h]).catch(() => null); if (tx) TO[h] = lc(tx.to); });
  wj(fCp, CP); wj(fTo, TO);
  return { CP, TO };
}
async function bnbDaily() {
  const P = rj(C('bnb-daily.json'), {});
  try {
    const start = Date.now() - 400 * 86400_000;
    const k = await (await fetch(`https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=1d&startTime=${start}&limit=1000`, { signal: AbortSignal.timeout(15000) })).json();
    klinesToDaily(k, P); wj(C('bnb-daily.json'), P);
  } catch {}
  return P;
}

// 免费领到的代币 → 止盈名单（free: true）
async function registerFree(w, H, skip) {
  const W = readWatch(w); W.tokens ||= [];
  const have = new Set(W.tokens.map(t => lc(t.contract))), used = new Set(W.tokens.map(t => t.id));
  const IFACE = id => '0x' + sel('supportsInterface(bytes4)') + id.padEnd(64, '0');
  const { add, paid } = await planFreeTokens(tokensFromHistory(H), { have, skip, onchain: async a => {
    const [b, d, n721, n1155] = await batch([[a, '0x' + sel('balanceOf(address)') + word(w.address)], [a, '0x' + sel('decimals()')], [a, IFACE('80ac58cd')], [a, IFACE('d9b67a26')]]);
    if (!b || b === '0x') return null;
    return { raw: big(b), decimals: d && d !== '0x' ? Number(big(d)) : 18, nft: big(n721) === 1n || big(n1155) === 1n };
  } });
  for (const t of add) {
    const id = tokenId(t.sym, t.contract, used); used.add(id);
    W.tokens.push({ id, name: t.sym, symbol: t.sym, contract: t.contract, cost: { BNB: 0 }, free: true, note: '免费领到，自动登记（开盘先卖一半，见 docs/auto.md）' });
  }
  if (add.length && !DRY) writeWatch(w, W);
  if (add.length || paid.length) log('FREE-TOKENS', w.id, `登记 ${add.length}：${add.map(t => t.sym).join(',')}`, paid.length ? `｜花了钱没登记的 ${paid.length}：${paid.map(t => `${t.sym} ${t.contract}`).join('；')}` : '');
  return { added: add.map(t => t.sym), paid };
}

export async function runPnl() {
  const P0 = config.pnl || {};
  const WS = await listWallets(), ME = new Map(WS.map(w => [lc(w.address), w.label || w.id]));
  // 你自己的其它地址（入金 / 提现用的）：["0x…"] 或 [{ "address": "0x…", "label": "我的冷钱包" }]
  const OWN = new Map((Array.isArray(P0.ownAddresses) ? P0.ownAddresses : []).map(x => typeof x === 'string' ? [lc(x), '你的地址 ' + x.slice(0, 6)] : [lc(x?.address), String(x?.label || '你的地址 ' + String(x?.address).slice(0, 6))]).filter(([a]) => /^0x[0-9a-f]{40}$/.test(a)));
  const nameOf = makeNamer({ projects: readJson('projects.json', []), merge: P0.merge || [], toNames: P0.contractNames || {} });
  const P = await bnbDaily(), dates = Object.keys(P).sort();
  const NOW = P[dates.at(-1)] || null;
  if (!NOW) throw new Error('读不到 BNB 日线价格（api.binance.com），这次不算');
  const pxOn = tm => P[dayOf(tm)] || NOW;
  const X = rj(C('exchange.json'), {}), ADJ = readJson('pnl-adjust.json', {}), prev = readJson('pnl.json', {});
  const skip = new Set((P0.skipTokens || []).map(lc));
  const out = { updated: Date.now(), bnbUsd: NOW, wallets: [] };
  for (const w of WS) {
    const stale = why => { log('PNL', w.id, why, '，沿用上一次'); const p = prev.wallets?.find(x => x.id === w.id); if (p) out.wallets.push({ ...p, stale: true }); };
    let H;
    try { H = await history(w); } catch (e) { stale(e.message); continue; }
    const { CP, TO } = await enrich(w, H);
    // 对方是谁：自己的钱包 / 登记的地址 / 交易所热钱包（只认转进 BNB / USDT 的，nonce 很大的普通地址）
    const exch = new Set();
    for (const mv of Object.values(CP)) for (const m of mv || []) {
      const o = m.from === lc(w.address) ? m.to : m.from;
      if (m.to === lc(w.address) && (m.tok === 'BNB' || m.tok === USDT) && !ME.has(o) && !OWN.has(o) && X[o] === undefined) exch.add(o);
    }
    await pool([...exch], 4, async a => {
      const [n, code] = await Promise.all([rpc('eth_getTransactionCount', [a, 'latest']).catch(() => null), rpc('eth_getCode', [a, 'latest']).catch(() => null)]);
      if (n != null) X[a] = looksLikeExchange(n, code);
    });
    const known = (o, m) => ME.get(o) || OWN.get(o) || ((m?.tok === 'BNB' || m?.tok === USDT) && m?.to === lc(w.address) && X[o] ? '交易所提币' : null);
    const bal = await baw(['wallet', 'balance', '--binanceChainId', String(config.chainId)], envFor(w));
    if (!bal?.success || !Array.isArray(bal.data)) { stale('余额读不到（' + (bal?.error?.message || '?') + '）'); continue; }   // 按 0 算会变成大亏
    const balance = bal.data.map(x => ({ sym: x.symbol, addr: lc(x.address), amt: +x.balance, usd: +x.value || 0 }));
    const R = walletPnl({ id: w.id, address: w.address, history: H, cp: CP, to: TO, known, nameOf, pxOn, nowPx: NOW, balance, adj: ADJ[w.id] || {} });
    R.label = w.label || w.id;
    out.wallets.push(R);
    log('PNL', w.id, '净', R.sum.pnl, '核对差', (R.check.actual - R.check.expect).toFixed(2));
    if (P0.registerFreeTokens !== false) await registerFree(w, H, skip).catch(e => log('ERR 免费代币登记', w.id, e.message));
  }
  wj(C('exchange.json'), X);
  out.total = +out.wallets.reduce((a, w) => a + (w.sum?.pnl || 0), 0).toFixed(2);
  if (!DRY) writeJson('pnl.json', out);
  return out;
}

let at = 0;
export async function pnlTick() {
  const P0 = config.pnl;
  if (!P0?.auto || Date.now() - at < (P0.everyHours || 6) * 3600_000) return;
  at = Date.now();
  await runPnl();
}
