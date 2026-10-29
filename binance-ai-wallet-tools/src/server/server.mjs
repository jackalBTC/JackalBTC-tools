#!/usr/bin/env node
// 本地只读看板。只监听本机（默认 127.0.0.1:8790），只处理 GET；不签名、不发交易、不读写钱包凭证。
// 多钱包（data/wallets.json）：余额 / 持仓 / NFT / 盈亏 / 复盘接口带 ?w=<钱包 id> 看单个钱包，?w=all 看全部合计，不带 = 主钱包。
// 用法: node src/server/server.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { config, readJson, writeJson, tailLines, ROOT } from '../lib/config.mjs';
import { batch, sel, word, big, addrOf, decodeStr, rpc, baw } from '../lib/chain.mjs';
import { readEvents } from '../lib/events.mjs';
import { listWallets, envFor, readWatch } from '../lib/wallets.mjs';
import { ADAPTERS } from './markets/index.mjs';
import { mergePositions, mergeOverview, mergeNfts, mergeOutcomes } from './merge.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(DIR, 'public');
const { host: HOST, port: PORT } = config.dashboard;
const skey = (k, w) => w.main ? k : `${k}-${w.id}`;   // 快照名：主钱包沿用原来的名字
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

// ---------- 缓存 ----------
const cache = new Map();
async function cached(key, ttl, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttl) return c.v;
  if (c?.p) return c.p;
  const p = fn().then(v => { cache.set(key, { t: Date.now(), v }); return v; }).catch(e => { cache.delete(key); throw e; });
  cache.set(key, { ...(c || {}), p });
  return p;
}
// 后台定时刷新：页面直接读上一次的结果（只有刚启动时要等第一次）
const snaps = new Map();
function snapshot(key, fn, every) {
  let s = snaps.get(key);
  if (!s) {
    // 结果存到 data/.snap-<key>.json，重启后先返回上次的结果，后台再刷新（避免重启后页面空白几分钟）
    const file = path.join(config.dataDir, `.snap-${key}.json`);
    s = { v: null, p: null, err: null };
    try { s.v = { ...JSON.parse(fs.readFileSync(file, 'utf8')), stale: true }; } catch {}
    const run = () => { s.p = fn().then(v => { s.v = v; s.err = null; try { fs.writeFileSync(file, JSON.stringify(v)); } catch {} }).catch(e => { s.err = String(e.message || e); }).finally(() => { s.p = null; if (s.dirty) { s.dirty = false; run(); } }); return s.p; };
    s.kick = () => { if (s.p) s.dirty = true; else run(); };   // 持仓清单改了：马上重算（正在算就算完再来一轮）
    run(); setInterval(() => { if (!s.p) run(); }, every);
    snaps.set(key, s);
  }
  return s.v ? Promise.resolve({ ...s.v, refreshing: !!s.p, error: s.err }) : (s.p || Promise.resolve()).then(() => s.v || { error: s.err || '加载中' });
}

// ---------- 钱包总览 ----------
async function overview(w) {
  const env = envFor(w);
  const [status, bal] = await Promise.all([baw(['wallet', 'status'], env), baw(['wallet', 'balance', '--binanceChainId', String(config.chainId)], env)]);
  const tokens = (bal.data || []).map(t => ({ symbol: t.symbol, address: t.address, balance: +t.balance, price: +t.price, value: +t.value }));
  return { wallet: w.address, walletId: w.id, label: w.label || w.id, status: status.data?.status || status.error?.message || 'UNKNOWN', tokens, tokensError: bal.success ? null : bal.error?.message,
    lowBnb: config.alerts.lowBnb, minBnbForTx: config.spending.minBnbForTx, at: Date.now() };
}

// ---------- NFT ----------
// tokenURI 来自任意合约，不可信：只允许 https / ipfs，拒绝内网和本机地址，不跟随跳转，限制大小（防 SSRF）
const ipfs = u => u && u.startsWith('ipfs://') ? 'https://ipfs.io/ipfs/' + u.slice(7).replace(/^ipfs\//, '') : u;
const privateIp = ip => {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  const x = ip.toLowerCase(); return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:');
};
async function safeFetchJson(raw) {
  const u = new URL(ipfs(raw));
  if (u.protocol !== 'https:') throw new Error('只允许 https');
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some(a => privateIp(a.address))) throw new Error('拒绝内网地址');
  const r = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  const len = Number(r.headers.get('content-length') || 0);
  if (len > 1 << 20) throw new Error('元数据太大');
  const text = await r.text();
  if (text.length > 1 << 20) throw new Error('元数据太大');
  return JSON.parse(text);
}
// 给浏览器的图片地址只放行 https、ipfs 网关和 data:image
const safeImage = v => { const u = ipfs(String(v || '')); return /^https:\/\//i.test(u) || /^data:image\/(png|gif|jpeg|webp|svg\+xml);/i.test(u) ? u : null; };
async function nftMeta(col, id) {
  if (col.image !== 'tokenURI') return {};
  return cached(`meta:${col.contract}:${id}`, 864e5, async () => {
    const [h] = await batch([[col.contract, '0x' + sel('tokenURI(uint256)') + word(id)]]);
    const uri = decodeStr(h); let j = null;
    try {
      if (uri.startsWith('data:application/json')) j = JSON.parse(uri.includes(';base64,') ? Buffer.from(uri.split(',')[1], 'base64').toString() : decodeURIComponent(uri.split(',').slice(1).join(',')));
      else if (/^(ipfs|https):\/\//.test(uri)) j = await safeFetchJson(uri);
    } catch { j = null; }
    if (!j) return { image: null };
    const attrs = Object.fromEntries((j.attributes || []).map(x => [x.trait_type, x.value]));
    const rarity = attrs.Rarity || attrs.rarity || attrs.Tier || attrs.tier || null;
    for (const k of ['Rarity', 'rarity', 'Tier', 'tier']) delete attrs[k];
    let image = safeImage(j.image);
    if (!image && j.image_data) image = 'data:image/svg+xml;base64,' + Buffer.from(String(j.image_data)).toString('base64');
    const str = v => typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, 60) : null;
    return { rarity: str(rarity), traits: Object.fromEntries(Object.entries(attrs).slice(0, 3).map(([k, v]) => [String(k).slice(0, 30), str(v)])), image };
  });
}
async function nfts(w) {
  const cols = readWatch(w).collections || [], me = w.address.toLowerCase();
  const res = await batch(cols.flatMap(c => (c.ids || []).map(id => [c.contract, '0x' + sel('ownerOf(uint256)') + word(id)])));
  let k = 0; const out = [];
  for (const c of cols) {
    const items = [];
    for (const id of c.ids || []) { const owned = addrOf(res[k++]) === me; items.push({ id, owned, ...(owned ? await nftMeta(c, id).catch(() => ({})) : {}) }); }
    out.push({ id: c.id, name: c.name, contract: c.contract, items });
  }
  return { collections: out, at: Date.now() };
}

// ---------- 持仓与市场 ----------
async function marketOf(c) {
  const m = c.market || { type: 'none' }, f = ADAPTERS[m.type];
  if (!f) return {};
  return cached('mkt:' + c.id, 600e3, () => f(m, c, { rarityOf: async id => (await nftMeta(c, id)).rarity })).catch(e => ({ note: '读取失败：' + e.message }));
}
async function supplyOf(c) {
  return cached('supply:' + c.contract, 300e3, async () => {
    const tryNum = async names => { for (const n of names) { const [h] = await batch([[c.contract, '0x' + sel(n)]]); if (h && h.length >= 66) { const v = Number(BigInt(h.slice(0, 66))); if (v > 0) return v; } } return null; };
    return { minted: await tryNum(['totalSupply()', 'totalMinted()']), max: c.maxSupply || await tryNum(['MAX_SUPPLY()', 'maxSupply()', 'MAX_MINTABLE()', 'MAX_TOKENS()', 'collectionSize()']) };
  }).catch(() => ({ minted: null, max: null }));
}
async function positions(w) {
  const wl = readWatch(w), cols = wl.collections || [], W = w.address;
  const bals = await batch(cols.map(c => [c.contract, '0x' + sel('balanceOf(address)') + word(W)]));
  const owned = Object.fromEntries((snaps.get(skey('nfts', w))?.v || await nfts(w)).collections.map(c => [c.id, c.items.filter(i => i.owned)]));
  const list = [];
  for (const [i, c] of cols.entries()) {
    const mk = await marketOf(c), items = owned[c.id] || [], heldByRarity = {};
    for (const it of items) if (it.rarity) heldByRarity[it.rarity] = (heldByRarity[it.rarity] || 0) + 1;
    let value = null;
    if (mk.floor != null) {
      if (mk.byRarity && items.length && items.every(it => it.rarity)) value = items.reduce((s, it) => s + (mk.byRarity[it.rarity]?.floor ?? mk.floor), 0);
      else value = mk.floor * Number(big(bals[i]));
    }
    list.push({ id: c.id, name: c.name, contract: c.contract, held: Number(big(bals[i])), url: c.market?.url || null,
      currency: c.market?.currency || null, marketType: c.market?.type || 'none', cost: c.cost || null,
      ...mk, heldByRarity, value, supply: await supplyOf(c) });
  }
  // 打到的代币（watch.json 的 tokens）：链上读余额，DexScreener 有交易池就算开盘（取流动性最大的池子报价）
  for (const t of wl.tokens || []) {
    const [b, d] = await batch([[t.contract, '0x' + sel('balanceOf(address)') + word(W)], [t.contract, '0x' + sel('decimals()')]]);
    const held = Number(big(b)) / 10 ** (Number(big(d)) || 18);
    const mk = await cached('dex:' + t.contract, 600e3, async () => {
      const j = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + t.contract, { signal: AbortSignal.timeout(20000) })).json();
      const p = (j.pairs || []).filter(x => x.chainId === 'bsc' && +x.priceUsd > 0).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      return p ? { floor: +p.priceUsd, liquidity: p.liquidity?.usd ?? null, url: /^https:\/\/dexscreener\.com\//.test(p.url) ? p.url : null } : {};
    }).catch(() => ({}));
    list.push({ id: t.id, name: t.name, symbol: t.symbol, contract: t.contract, kind: 'token', held, cost: t.cost || null,
      marketType: mk.floor != null ? 'dex' : 'none', currency: 'USD', floor: mk.floor ?? null, liquidity: mk.liquidity ?? null,
      url: mk.url || null, value: mk.floor != null ? mk.floor * held : null, note: mk.floor != null ? null : '还没开盘（没有交易池）' });
  }
  return { positions: list, at: Date.now() };
}

// ---------- 复盘：开没开市场、地板价、链上整包授权（疑似开了市场） ----------
const APPROVAL_ALL = '0x17307eab39ab6107e8899845ad3d59bd9653f200a220920489ca2b5937696c31';
// 按钱包复盘：用这个钱包的持仓清单和持仓快照；授权事件的扫描进度按合约共用
async function outcomes(w) {
  const st = readJson('outcomes-state.json', {});
  const head = Number(await rpc('eth_blockNumber', []));
  const pos = snaps.get(skey('pos', w))?.v?.positions || [], projects = readJson('projects.json', []);
  const out = [], R = config.rpc.logsMaxRange;
  for (const c of readWatch(w).collections || []) {
    const s = st[c.contract.toLowerCase()] ||= { from: head - R, ops: {} };
    if (!c.market || c.market.type === 'none') {
      try {
        const logs = await rpc('eth_getLogs', [{ address: c.contract, topics: [APPROVAL_ALL], fromBlock: '0x' + Math.max(s.from, head - R).toString(16), toBlock: '0x' + head.toString(16) }], config.rpc.logs);
        for (const l of logs) if (l.data.endsWith('1')) { const o = s.ops[addrOf(l.topics[2])] ||= { n: 0, owners: [] }; o.n++; const ow = addrOf(l.topics[1]); if (!o.owners.includes(ow)) o.owners.push(ow); o.owners = o.owners.slice(-50); }
        s.from = head + 1;
      } catch (e) { s.err = String(e.message).slice(0, 80); }
    }
    const ops = Object.entries(s.ops).map(([op, o]) => ({ op, holders: o.owners.length, n: o.n })).sort((a, b) => b.holders - a.holders);
    const p = pos.find(x => x.id === c.id) || {}, pj = projects.find(x => x.id === c.id) || {};
    out.push({ id: c.id, name: c.name, contract: c.contract, held: p.held ?? null, cost: p.cost ?? null,
      market: c.market?.type && c.market.type !== 'none' ? c.market.type : null, floor: p.floor ?? null, listed: p.listed ?? null, value: p.value ?? null, currency: p.currency ?? null,
      suspectMarket: ops.find(o => o.holders >= 3) || null, airdrop: pj.outcome?.airdrop || null, note: pj.outcome?.note || null, supply: p.supply || null });
  }
  writeJson('outcomes-state.json', st);
  return { list: out, at: Date.now() };
}

// ---------- 雷达 / 后台任务 ----------
const running = pattern => new Promise(r => execFile('pgrep', ['-f', pattern], (e, o) => r(!e && String(o).trim().length > 0)));
const RADAR_LOG = path.join(ROOT, 'logs/radar.log');
async function radar() {
  const st = readJson('radar-state.json', {});
  const cands = tailLines('radar-candidates.jsonl', 300).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const projects = readJson('projects.json', []);
  const match = c => projects.find(p => (c.cas || []).some(a => Object.values(p.contracts || {}).map(x => String(x).toLowerCase()).includes(a)) || (c.domains || []).some(d => (p.site || '').includes(d)));
  const recent = cands.filter(c => c.kind !== 'update').slice(-40).reverse().map(c => { const p = match(c); return { ...c, project: p ? { id: p.id, name: p.name, status: p.status } : null }; });
  return { running: await running('src/radar/radar.mjs'), provider: config.radar.provider, lastRun: st.lastRun || null, cost: st.cost || null,
    intervalMinutes: config.radar.intervalMinutes, total: cands.length, recent, lines: tailLines(RADAR_LOG, 6), at: Date.now() };
}

// ---------- 多钱包 ----------
const PER_WALLET = new Set(['/api/wallets', '/api/overview', '/api/nfts', '/api/realized', '/api/positions', '/api/outcomes']);
const ov = w => cached('ov-' + w.id, 30e3, () => overview(w));
// 持仓清单（主钱包 data/watch.json，副钱包 data/wallets/<id>/watch.json）一改就立刻刷新持仓
const watched = new Set();
function watchWallet(w) {
  if (watched.has(w.watchFile)) return;
  watched.add(w.watchFile);
  fs.watchFile(w.watchFile, { interval: 3000 }, () => { snaps.get(skey('nfts', w))?.kick(); snaps.get(skey('pos', w))?.kick(); });
}

// ---------- HTTP ----------
http.createServer(async (req, res) => {
  const okHost = [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`];
  if (!okHost.includes(String(req.headers.host || '').toLowerCase())) { res.writeHead(403); return res.end('forbidden host'); }
  const url = new URL(req.url, 'http://x');
  const json = (v, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(v)); };
  try {
    if (req.method !== 'GET') return json({ error: '只读看板，不接受写操作' }, 405);
    if (PER_WALLET.has(url.pathname)) {
      const WS = await listWallets();   // wallets.json 写错会在这里报错，不悄悄回退
      for (const w of WS) watchWallet(w);   // 后来新加的钱包也能「改了持仓立刻刷新」
      if (url.pathname === '/api/wallets') return json(WS.map(w => ({ id: w.id, label: w.label || w.id, address: w.address, main: w.main, allowPaid: !!w.allowPaid, agentId: w.agentId || null })));   // 不暴露会话目录、环境变量、文件路径
      const q = url.searchParams.get('w'), ALL = q === 'all', main = WS.find(w => w.main);
      const w = !q ? main : WS.find(x => x.id.toLowerCase() === q.toLowerCase());
      if (!ALL && !w) return json({ error: '没有这个钱包：' + q }, 400);
      const each = (fn, empty) => Promise.all(WS.map(x => fn(x).catch(e => ({ ...empty, error: String(e.message || e) })).then(v => ({ w: x, v }))));   // 某个钱包出错不拖垮合计
      const warn = rs => rs.filter(r => r.v?.error).map(r => `${r.w.id}：${r.v.error}`);
      switch (url.pathname) {
        case '/api/overview': {
          if (!ALL) return json(await ov(w));
          const rs = await each(ov, { tokens: [] });
          return json(mergeOverview(rs.map(({ w, v }) => v.error ? { walletId: w.id, status: v.error, tokens: [] } : v)));
        }
        case '/api/nfts': {
          if (!ALL) return json(await snapshot(skey('nfts', w), () => nfts(w), 5 * 60e3));
          const rs = await each(x => snapshot(skey('nfts', x), () => nfts(x), 5 * 60e3), { collections: [] });
          return json({ collections: mergeNfts(rs.map(r => r.v.collections)), warnings: warn(rs), at: Date.now() });
        }
        case '/api/realized': {   // realized.json 每条可带 wallet 字段，没有的算主钱包
          const L = readJson('realized.json', []);
          return json({ list: ALL ? L : L.filter(r => String(r.wallet || main.id).toLowerCase() === w.id.toLowerCase()) });
        }
        case '/api/positions': {
          if (!ALL) return json(await snapshot(skey('pos', w), () => positions(w), 5 * 60e3));
          const rs = await each(x => snapshot(skey('pos', x), () => positions(x), 5 * 60e3), { positions: [] });
          return json({ positions: mergePositions(rs.map(r => r.v.positions)), warnings: warn(rs), at: Date.now() });
        }
        case '/api/outcomes': {
          if (!ALL) return json(await snapshot(skey('out', w), () => outcomes(w), 30 * 60e3));
          const rs = await each(x => snapshot(skey('out', x), () => outcomes(x), 30 * 60e3), { list: [] });
          return json({ list: mergeOutcomes(rs.map(r => r.v.list)), warnings: warn(rs), at: Date.now() });
        }
      }
    }
    switch (url.pathname) {
      case '/api/radar': return json(await cached('radar', 15e3, radar));
      case '/api/events': return json(readEvents(300).reverse());
      case '/api/today': {   // 今天的到手笔数：读完整日志，不受列表条数限制
        const day = new Date().toDateString(), ex = readEvents(1e6).filter(e => e.action === 'confirm' && new Date(e.ts).toDateString() === day).map(e => e.project);
        return json({ count: ex.length, projects: [...new Set(ex)] });
      }
      case '/api/news': return json(readJson('news.json', []).sort((a, b) => String(b.ts).localeCompare(String(a.ts))));
      case '/api/projects': {
        const ps = readJson('projects.json', []);
        const cands = tailLines('radar-candidates.jsonl', 2000).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        for (const p of ps) {   // lastSeen：雷达最后一次扫到该项目的时间（关掉的待确认卡片据此重新出现）
          const cas = Object.values(p.contracts || {}).map(x => String(x).toLowerCase());
          const h = (p.site || '').replace(/^https?:\/\//, '').split('/')[0];
          const hit = cands.filter(c => (c.cas || []).some(a => cas.includes(a)) || (h && (c.domains || []).includes(h))).pop();
          p.lastSeen = hit ? hit.ts : null;
        }
        return json(ps);
      }
    }
    const file = path.join(PUB, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json({ error: 'not found' }, 404);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { json({ error: String(e.message || e) }, 502); }
}).listen(PORT, HOST, async () => {
  console.log(`看板已启动：http://${HOST}:${PORT}`);
  let WS = [];
  try { WS = await listWallets(); } catch (e) { console.error(e.message); }
  // 每个钱包都在后台刷新；持仓清单一改就立刻重算，不用等 5 分钟的定时
  for (const w of WS) { snapshot(skey('nfts', w), () => nfts(w), 5 * 60e3); snapshot(skey('pos', w), () => positions(w), 5 * 60e3); watchWallet(w); }
  setTimeout(async () => { for (const w of WS) await snapshot(skey('out', w), () => outcomes(w), 30 * 60e3).catch(() => {}); }, 90e3);   // 一个个来，复盘扫描进度是共用的
});
