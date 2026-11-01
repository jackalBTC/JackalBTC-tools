// 付费项目防骗检查的纯逻辑：不联网、不读写文件。src/lib/devcheck.mjs 调用，test/ 里有单元测试。
// 检查什么、为什么，见 docs/security.md「付费项目防骗检查」。
import crypto from 'node:crypto';

// ---------- 本机随机门槛 ----------
// 每台机器第一次运行时在范围内随机定一次，之后固定（data/thresholds.json）。门槛公开了，做盘的人就能刚好做到门槛上；
// 每台机器不一样，就没法量身定做。删掉 data/thresholds.json 会重新随机一次。
export const THRESHOLD_RANGES = {
  paidProgress: [60, 70],        // 付费按份铸币：进度（%）至少多少才考虑进场
  minSenders: [20, 30],          // 自己发交易铸造过的钱包至少几个
  minSendersDrained: [40, 55],   // 钱没留在合约里（合约几乎没有 BNB / USDT）时，至少几个
};
const rnd = (lo, hi, r) => lo + Math.floor(r() * (hi - lo + 1));
export function makeThresholds(rand = Math.random, now = new Date()) {
  const t = {};
  for (const [k, [lo, hi]] of Object.entries(THRESHOLD_RANGES)) t[k] = Math.min(hi, rnd(lo, hi, rand));
  t.created = now.toISOString();
  return t;
}
// 文件里的门槛是否可用（被手改坏了就重新生成）
export const validThresholds = t => !!t && Object.entries(THRESHOLD_RANGES).every(([k, [lo, hi]]) => Number.isInteger(t[k]) && t[k] >= lo && t[k] <= hi);

// ---------- 铸造人数：按交易发起人（tx.from）算 ----------
// 按 Transfer 的收款地址算人数，空投 / 代铸一笔就能刷出几百个「铸造者」；只有自己发交易、自己付 gas 的钱包才算人。
// 一条铸造日志算几份：NFT（721，4 个 topic）一张算 1；代币（20）按数量 / 1e18。
export function mintUnits(log, is721) {
  if (is721 || log?.topics?.length === 4) return 1;
  try { return Number(BigInt(log?.data && log.data !== '0x' ? log.data.slice(0, 66) : '0x0')) / 1e18; } catch { return 0; }
}
// logs：铸造日志（Transfer from 0x0）；froms：Map(txHash → 发起人地址，小写)
// 返回 { senders 发起人个数, recipients 收到铸造的地址个数, total 总份数, bySender: Map, top: { address, units, share } | null }
export function senderStats(logs, froms, is721) {
  const bySender = new Map(), recipients = new Set();
  let total = 0;
  for (const l of logs || []) {
    if (l?.topics?.[2]) recipients.add(String(l.topics[2]).toLowerCase());
    const f = froms.get(l.transactionHash); if (!f) continue;
    const u = mintUnits(l, is721); total += u;
    bySender.set(f, (bySender.get(f) || 0) + u);
  }
  const best = [...bySender.entries()].sort((a, b) => b[1] - a[1])[0];
  return { senders: bySender.size, recipients: recipients.size, total, bySender,
    top: best && total > 0 ? { address: best[0], units: best[1], share: best[1] / total } : null };
}
// 判断：人数够不够、是不是一个地址自己刷进度（诱饵盘）。drained：合约里几乎没有 BNB / USDT（钱直接流去了别处）
export const TOP_SHARE = 0.3;
export function judgeMinting(st, T, { drained = false, owner = null } = {}) {
  const block = [], warn = [];
  const need = drained ? T.minSendersDrained : T.minSenders;
  if (st.senders < need) block.push(`只有 ${st.senders} 个钱包自己发交易铸造过（收到铸造的地址 ${st.recipients} 个；${drained ? '钱没留在合约里，' : ''}要求 ≥${need}），进度可能是刷的`);
  if (drained) warn.push('合约里几乎没有 BNB / USDT：钱可能直接流向别处');
  if (st.top && st.top.share > TOP_SHARE) block.push(st.senders >= 2
    ? `单个地址 ${st.top.address} 铸了 ${(st.top.share * 100).toFixed(0)}%，像项目方自己刷进度的诱饵盘`
    : `几乎只有 ${st.top.address} 一个地址在铸，像诱饵盘`);
  const o = owner && st.total > 0 ? (st.bySender.get(owner) || 0) / st.total : 0;
  if (o > 0.1) warn.push(`owner 自己铸了 ${(o * 100).toFixed(0)}%`);
  return { block, warn };
}
export const isDrained = (bnb, usdt) => bnb < 0.01 && usdt < 5;

// ---------- 合约代码指纹 ----------
// EIP-1167 最小代理：换成背后实现合约的代码再算（同一个实现批量克隆出来的盘，壳一样、实现也一样）
const MINIMAL_PROXY = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;
export const minimalProxyTarget = code => { const m = String(code || '').match(MINIMAL_PROXY); return m ? '0x' + m[1].toLowerCase() : null; };
export const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24);
export const codeHash = code => code && code.length > 4 ? sha(String(code).toLowerCase()) : null;
export const SAME_CODE_LIMIT = 3;
// 「见过的合约」cache：{ ca: { code, seen } }。返回 24 小时内代码和 ca 相同的合约（含它自己）
export function sameCodeWithin(cache, ca, now = Date.now(), windowMs = 86400_000) {
  const mine = cache[ca]?.code;
  if (!mine) return [];
  return Object.entries(cache).filter(([c, v]) => v?.code === mine && (c === ca || now - Date.parse(v.seen || 0) < windowMs)).map(([c]) => c);
}
// radar-candidates.jsonl 的行 → Map(合约地址 → 最早出现时间 ISO)，只要 windowMs 内的
export function recentCandidateCas(lines, now = Date.now(), windowMs = 86400_000) {
  const out = new Map();
  for (const l of lines || []) {
    let j; try { j = typeof l === 'string' ? JSON.parse(l) : l; } catch { continue; }
    const t = Date.parse(j?.ts);
    if (!j || !Number.isFinite(t) || now - t > windowMs) continue;
    for (const c of j.cas || []) if (/^0x[0-9a-fA-F]{40}$/.test(c)) { const k = c.toLowerCase(); if (!out.has(k) || Date.parse(out.get(k)) > t) out.set(k, j.ts); }
  }
  return out;
}

// ---------- NFT 图片 ----------
export const toGateway = u => String(u).replace(/^ipfs:\/\/(ipfs\/)?/i, 'https://ipfs.io/ipfs/').replace(/^ar:\/\//i, 'https://arweave.net/');
// ipfs:// 依次试这几个网关（一个限流 / 挂了不等于图是假的）；ar:// 走 arweave.net；http(s) 就用它自己
export const IPFS_GATEWAYS = ['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://w3s.link/ipfs/'];
export function gatewaysFor(u) {
  const s = String(u), m = s.match(/^ipfs:\/\/(?:ipfs\/)?(.+)$/i);
  if (m) return IPFS_GATEWAYS.map(g => g + m[1]);
  const h = s.match(/^https?:\/\/[^/]+\/ipfs\/(.+)$/i);   // 写成某个网关的 https 链接：先试它自己，再试别的网关
  if (h) return [s, ...IPFS_GATEWAYS.map(g => g + h[1]).filter(x => x !== s)];
  return [toGateway(s)];
}
// 一次请求的结果 → 'ok' | 'bad'（明确不对：404 / 400 之类）| 'unavailable'（限流 429、超时 408、5xx、网络错误：只提醒，不当成假图）
export function httpOutcome(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 408 || status === 429 || status >= 500 || !status) return 'unavailable';
  return 'bad';
}
// 几个网关的结果合起来：有一个 ok 就 ok；全都明确 bad 才 bad；其余（有限流 / 超时 / 网络错误）算 unavailable
export const combineOutcomes = list => list.includes('ok') ? 'ok' : list.length && list.every(x => x === 'bad') ? 'bad' : 'unavailable';
// ipfs:// 链接的 CID 必须像真的（Qm… 46 位或 b… 的 v1）；不是 ipfs 链接的返回 true
export function cidOk(u) {
  const m = String(u).match(/^ipfs:\/\/(?:ipfs\/)?([^/?#]+)/i);
  return !m || /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/.test(m[1]);
}
const short = s => String(s).replace(/[\u0000-\u001f\u007f-\u009f<>]/g, ' ').slice(0, 60);
// tokenURI 字符串 → { meta }（data: 内嵌的 JSON）| { urls }（要去下载，按顺序试）| { block: 原因 }
export function parseTokenUri(uri) {
  uri = String(uri || '').trim();
  if (!uri) return { block: 'NFT 没有 tokenURI（图片资料是空的），像批量掏手续费的垃圾 NFT' };
  if (/^data:application\/json;base64,/i.test(uri)) { try { return { meta: JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString()) }; } catch { return { block: 'tokenURI 内嵌的资料读不出来' }; } }
  if (/^data:application\/json/i.test(uri)) { try { return { meta: JSON.parse(decodeURIComponent(uri.slice(uri.indexOf(',') + 1))) }; } catch { return { block: 'tokenURI 内嵌的资料读不出来' }; } }
  if (/^(https?|ipfs|ar):\/\//i.test(uri)) return cidOk(uri) ? { urls: gatewaysFor(uri) } : { block: `tokenURI 是假的 IPFS 链接（${short(uri)}）` };
  return { block: `tokenURI 不是正常链接（${short(uri)}）` };
}
// 资料里的图片 → { image, onchain }（链上图不用下载）| { image, urls }（要探一下能不能打开，按顺序试）| { block }
export function imageOf(meta) {
  const img = String(meta?.image || meta?.image_url || meta?.animation_url || '').trim();
  if (!img) return { block: 'NFT 资料里没有图片' };
  if (/^data:image\//i.test(img) || /^<svg/i.test(img)) return { image: img, onchain: true };
  if (!/^(https?|ipfs|ar):\/\//i.test(img) || !cidOk(img)) return { block: `图片链接是假的（${short(img)}）` };
  return { image: img, urls: gatewaysFor(img) };
}
// 图片的比对键：链上 SVG / data 图按内容指纹，链接按网关地址（去掉 ? 后面）
export const imageKey = img => /^data:|^<svg/i.test(img) ? 'svg:' + sha(img) : toGateway(img).replace(/\?.*$/, '').toLowerCase();
// 图片索引 { key: [合约…] }：记下 ca，返回用过同一张图的别的合约
export function noteImage(index, key, ca) {
  const others = (index[key] || []).filter(c => c !== ca);
  index[key] = [...new Set([...(index[key] || []), ca])].slice(-20);
  return others;
}

export const verdictOf = out => out.block.length ? '拦' : out.warn.length ? '可打，但有提醒' : '通过';
