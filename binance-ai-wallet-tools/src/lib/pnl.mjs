// 钱包整体盈亏：纯函数，不联网。src/cli/pnl.mjs 负责拉数据，test/ 里有单元测试。
// 方法（按钱包算，不依赖卖出记录记全没有）：
//   盈亏 = 现在钱包里的总值 + 转回给你的 + 加回项（转出去之后你卖掉 / 还剩 / 待退的） − 你转进来的本金
//   「转进 / 转出」只认这几类对方地址：wallets.json 里自己的钱包、config.pnl.ownAddresses 里你登记的地址、交易所热钱包（nonce 很大的普通地址）。
//   其余交易一律算「项目」：按台账合约名 / 代币符号归类，记 BNB / USDT 的净收支和 gas（BNB 按交易当天的收盘价折美元）。
//   核对：转入 − 转出 + 各项目净收支 − gas ≈ 钱包里现有的 BNB / USDT。差得多说明有转账没认出来（比如别的入金地址没登记）。
const lc = a => String(a || '').toLowerCase();
export const BASE = new Set(['BNB', 'USDT', 'WBNB']);
export const USDT = '0x55d398326f99059ff775485246999027b3197955';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const TRANSFER_TYPES = ['transfer', 'deposit', 'withdraw', 'sale'];   // baw tx-history 里可能是资金进出的交易类型
export const EXCHANGE_NONCE = 100_000;

// 一笔交易里和「我」有关的 BNB / 代币转移（来自链上交易 + 回执）
export function movesOf(tx, rc, me) {
  me = lc(me);
  if (!tx || !rc) return null;
  const mv = [];
  const v = BigInt(tx.value || 0);
  if (v > 0n && (lc(tx.from) === me || lc(tx.to) === me)) mv.push({ tok: 'BNB', from: lc(tx.from), to: lc(tx.to), raw: v.toString() });
  for (const l of rc.logs || []) {
    if (l?.topics?.[0] !== TRANSFER || l.topics.length !== 3) continue;
    const a = '0x' + l.topics[1].slice(26).toLowerCase(), b = '0x' + l.topics[2].slice(26).toLowerCase();
    if (a === me || b === me) mv.push({ tok: lc(l.address), from: a, to: b, raw: BigInt(l.data && l.data !== '0x' ? l.data.slice(0, 66) : 0).toString() });
  }
  return mv;
}

// 交易所热钱包：普通地址（没有合约代码）且发过的交易数很大
export const looksLikeExchange = (nonceHex, code) => !!(nonceHex && parseInt(nonceHex, 16) > EXCHANGE_NONCE && (!code || code === '0x'));

// 交易归到哪个项目：先看台账（合约地址 → 项目名），再看代币符号；merge 规则把同一项目的不同名字并到一起
//   merge: [{ match: "正则", name: "显示名" }]（config.pnl.merge），toNames: { 合约地址: 显示名 }（config.pnl.contractNames）
export function makeNamer({ projects = [], merge = [], toNames = {} } = {}) {
  const A2P = {};
  for (const p of projects || []) for (const v of Object.values(p?.contracts || {})) if (/^0x[0-9a-fA-F]{40}$/.test(String(v))) A2P[lc(v)] = p.name || p.id;
  const rules = (merge || []).map(m => { try { return [new RegExp(m.match, 'i'), String(m.name)]; } catch { return null; } }).filter(Boolean);
  const TN = Object.fromEntries(Object.entries(toNames || {}).map(([k, v]) => [lc(k), v]));
  return (addr, sym) => {
    addr = lc(addr);
    if (TN[addr]) return TN[addr];
    const n = A2P[addr] || sym || (addr ? addr.slice(0, 10) : '其它');
    for (const [re, name] of rules) if (re.test(n) || (sym && re.test(sym))) return name;
    return n;
  };
}

// 一个钱包的盈亏。全部输入都已经拉好：
//   history  baw wallet tx-history 的交易列表（新的在前）
//   cp       { txHash: movesOf(...) }（只有转账类交易有）；to { txHash: 被调用的合约 }（只有 BNB/USDT 进出的交易需要）
//   known(addr)  → 对方是谁（字符串）或 null：自己的钱包 / 登记的地址 / 交易所
//   nameOf(addr, sym)  见 makeNamer；pxOn(time) 那天的 BNB 价；nowPx 现价
//   balance  [{ sym, addr, amt, usd }]（baw wallet balance）；adj  data/pnl-adjust.json 里这个钱包的加回项 { 项目名: [{ usd | bnb, at?, note }] }
export function walletPnl({ id, address, history = [], cp = {}, to = {}, known, nameOf, pxOn, nowPx, balance = [], adj = {} }) {
  const me = lc(address), flows = [], tokOut = {}, proj = {};
  let gasBnb = 0;
  const P = k => (proj[k] ||= { net: 0, gas: 0, n: 0 });
  for (const t of history) {
    const px = pxOn(t.txTime), ok = t.status === 'confirmed';
    for (const h of t.txHashList || []) {
      const fee = Number(h.networkFee?.feeValue || 0) / 1e18; gasBnb += fee;
      const S = h.instructions?.send || [], V = h.instructions?.receive || [];
      const usd = x => x.tokenInfo?.symbol === 'USDT' ? Number(x.amount) : Number(x.amount) * px;
      const mv = cp[h.txHash];
      let ext = false;
      if (Array.isArray(mv) && ok) {
        for (const m of mv) if (known(m.from === me ? m.to : m.from, m)) ext = true;
        if (ext) for (const m of mv) {
          const out = m.from === me, o = out ? m.to : m.from, who = known(o, m) || o.slice(0, 10), a = Number(m.raw) / 1e18;
          if (m.tok === 'BNB' || m.tok === USDT) flows.push({ tm: String(t.txTime).slice(0, 16), dir: out ? 'out' : 'in', who, tok: m.tok === 'BNB' ? 'BNB' : 'USDT', amt: a, usd: m.tok === 'BNB' ? a * px : a });
          else if (out) { const k = who + '|' + m.tok; tokOut[k] = (tokOut[k] || 0) + a; }
        }
      }
      if (ext) { P('（转账 gas）').gas += fee * px; continue; }
      const notBase = x => !BASE.has(x.tokenInfo?.symbol);
      const x = V.find(notBase) || S.find(notBase);
      const key = x ? nameOf(x.tokenInfo.contractAddress, x.tokenInfo.symbol) : nameOf(to[h.txHash] || '', null);
      const net = V.filter(y => !notBase(y)).reduce((a, y) => a + usd(y), 0) - S.filter(y => !notBase(y)).reduce((a, y) => a + usd(y), 0);
      const p = P(key); if (ok) p.net += net; p.gas += fee * px; p.n++;
    }
  }
  const bal = { bnb: balance.find(x => x.sym === 'BNB')?.amt || 0, usd: balance.reduce((a, x) => a + (x.usd || 0), 0), base: balance.filter(x => BASE.has(x.sym)).reduce((a, x) => a + (x.usd || 0), 0),
    tokens: balance.filter(x => !BASE.has(x.sym) && x.usd >= 0.01) };
  const addOf = list => (list || []).reduce((a, x) => a + (x.bnb != null ? Number(x.bnb) * (x.at ? pxOn(x.at) : nowPx) : Number(x.usd) || 0), 0);
  const names = new Set([...Object.keys(proj).filter(k => !k.startsWith('（转账')), ...Object.keys(adj || {})]);
  const rows = [...names].map(k => {
    const v = proj[k] || { net: 0, gas: 0, n: 0 }, add = addOf(adj?.[k]);
    return { name: k, net: +v.net.toFixed(2), add: +add.toFixed(2), gas: +v.gas.toFixed(2), pnl: +(v.net + add - v.gas).toFixed(2), n: v.n, notes: (adj?.[k] || []).map(x => x.note).filter(Boolean) };
  }).sort((a, b) => b.pnl - a.pnl);
  const IN = flows.filter(f => f.dir === 'in').reduce((a, f) => a + f.usd, 0), OUT = flows.filter(f => f.dir === 'out').reduce((a, f) => a + f.usd, 0);
  const added = rows.reduce((a, r) => a + r.add, 0), transferGas = proj['（转账 gas）']?.gas || 0;
  const sum = { in: +IN.toFixed(2), out: +OUT.toFixed(2), balance: +bal.usd.toFixed(2), added: +added.toFixed(2), gasBnb: +gasBnb.toFixed(5),
    pnl: +(bal.usd + OUT + added - IN).toFixed(2), byProject: +(rows.reduce((a, r) => a + r.pnl, 0) - transferGas + (bal.usd - bal.base)).toFixed(2) };
  const chain = Object.values(proj).reduce((a, v) => a + v.net - v.gas, 0);
  return { id, address, txs: history.length, since: history.at(-1)?.txTime || null, flows, gasBnb: +gasBnb.toFixed(6), balance: bal, rows, sum,
    check: { expect: +(IN - OUT + chain).toFixed(2), actual: +bal.base.toFixed(2) },
    tokOut: Object.entries(tokOut).map(([k, a]) => ({ to: k.split('|')[0], token: k.split('|')[1], amt: a })) };
}

// 增量拉交易历史时合并：遇到已缓存的哈希就停。pages 是按顺序拉到的页（每页 { transactions, hasMore, nextCursor }）
// 返回 { fresh, done }：done = 确实接上了旧缓存 / 拉到了底；没 done 的结果不能写缓存（否则中间那段永远补不回来）
export function mergePage(page, seen, fresh) {
  for (const t of page?.transactions || []) {
    if (t.status === 'pending') continue;
    if (seen.has(t.txHashList?.[0]?.txHash)) return { stop: true, done: true };
    fresh.push(t);
  }
  if (!page?.hasMore || !page?.nextCursor) return { stop: true, done: true };
  return { stop: false, done: false, cursor: String(page.nextCursor) };
}

// Binance 日 K 线 → { 'YYYY-MM-DD'(UTC+8): 收盘价 }
export function klinesToDaily(k, into = {}) {
  for (const r of Array.isArray(k) ? k : []) if (Array.isArray(r) && +r[4] > 0) into[new Date(Number(r[0]) + 8 * 3600_000).toISOString().slice(0, 10)] = +r[4];
  return into;
}
export const dayOf = tm => new Date(Date.parse(tm) + 8 * 3600_000).toISOString().slice(0, 10);
