// 付费项目防骗检查（只读链，不发交易、不签名）。mint.mjs 付费前自动跑；也可以单独跑：node src/cli/devcheck.mjs <合约>
// 任何一条「拦」：mint 的付费部分不打（只拿免费张），AI 写付费简报时要写明结论。
//   ① 人数只算自己发交易铸造的钱包（tx.from），少于本机门槛 → 拦；合约里几乎没有 BNB / USDT（钱流去了别处）门槛更高
//   ② 单个地址铸了 >30% → 拦（项目方自己刷进度的诱饵盘）
//   ③ 门槛每台机器随机一次（data/thresholds.json）：付费进度 60–70%、最少发交易钱包 20–30（钱不在合约里时 40–55）
//   ④ NFT 图片：tokenURI 空 / 假 IPFS / 链接不存在（404 之类）/ 不是图 / 没图 → 拦；ipfs:// 依次试 4 个网关，
//      限流（429）、5xx、超时、网络错误只提醒，不当成假图；同一张图在别的合约用过 → 拦（data/nft-images.json）
//   ⑤ 同一份合约代码（跟进 EIP-1167 最小代理和 EIP-1967 代理的实现合约）24 小时内出现 ≥3 个 → 拦
//      「见过的合约」= 雷达 24 小时内的候选（data/radar-candidates.jsonl 的 cas）+ 24 小时内跑过防骗检查的合约（data/devcheck-codes.json）
// 纯逻辑在 src/lib/scam.mjs（有单元测试）。
import { readJson, writeJson, tailLines } from './config.mjs';
import { rpc, ethCall, getLogs, decodeStr, addrOf, sel, word, big, calldata } from './chain.mjs';
import { makeThresholds, validThresholds, senderStats, judgeMinting, isDrained, minimalProxyTarget, codeHash,
  sameCodeWithin, SAME_CODE_LIMIT, recentCandidateCas, parseTokenUri, imageOf, imageKey, noteImage, verdictOf, httpOutcome, combineOutcomes } from './scam.mjs';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', ZERO64 = '0x' + '0'.repeat(64);
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const WINDOW_BLOCKS = 20000, MAX_TX = 400, MAX_NEW_CODES = 60;

// 本机门槛：第一次用时随机生成并保存；删掉 data/thresholds.json 会重新生成
export function thresholds() {
  let t = readJson('thresholds.json', null);
  if (!validThresholds(t)) { t = makeThresholds(); writeJson('thresholds.json', t); }
  return t;
}

async function codeKey(ca) {
  let code = await rpc('eth_getCode', [ca, 'latest']) || '0x';
  let impl = minimalProxyTarget(code);
  if (!impl) { const sl = await rpc('eth_getStorageAt', [ca, IMPL_SLOT, 'latest']).catch(() => null); if (sl && BigInt(sl) !== 0n) impl = addrOf(sl); }
  if (impl) code = await rpc('eth_getCode', [impl, 'latest']).catch(() => null) || code;
  return codeHash(code);
}

async function txFroms(hashes) {   // 交易发起人，并发 8
  const out = new Map(), q = [...hashes];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (q.length) { const h = q.shift(); try { const t = await rpc('eth_getTransactionByHash', [h]); if (t?.from) out.set(h, t.from.toLowerCase()); } catch {} }
  }));
  return out;
}

// 请求一个链接：→ { outcome: 'ok' | 'bad' | 'unavailable', res }。读不读 body 由调用方决定；不读就必须 cancel，
// 否则连接挂着，命令行跑完不退出
async function hit(url, headers = {}) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000), redirect: 'follow' });
    const outcome = r.status === 206 ? 'ok' : httpOutcome(r.status);
    if (outcome !== 'ok') r.body?.cancel().catch(() => {});
    return { outcome, res: outcome === 'ok' ? r : null };
  } catch { return { outcome: 'unavailable', res: null }; }   // 超时 / 网络错误：只提醒
}
// 图片能不能打开：几个网关按顺序试，一个通了就算。只看响应头，body 直接取消
async function probeImage(urls) {
  const seen = [];
  for (const u of urls) {
    const { outcome, res } = await hit(u, { range: 'bytes=0-2047' });
    if (res) {
      const ct = res.headers.get('content-type') || '';
      res.body?.cancel().catch(() => {});
      if (!/^image\/|^video\/|octet-stream/i.test(ct)) return 'bad';   // 打开了但不是图
      return 'ok';
    }
    seen.push(outcome);
  }
  return combineOutcomes(seen);
}
// 读 NFT 资料（JSON）：→ { meta } | { outcome: 'bad' | 'unavailable' | 'notjson' }
async function fetchMeta(urls) {
  const seen = [];
  for (const u of urls) {
    const { outcome, res } = await hit(u);
    if (res) {
      const meta = await res.json().catch(e => /abort|timeout/i.test(String(e?.name || e)) ? undefined : null);   // 读到一半超时：算暂时读不到
      if (meta === undefined) { seen.push('unavailable'); continue; }
      return meta && typeof meta === 'object' ? { meta } : { outcome: 'notjson' };
    }
    seen.push(outcome);
  }
  return { outcome: combineOutcomes(seen) };
}

async function nftImageCheck(ca, tokenId, out, save) {
  const r = await ethCall({ to: ca, data: calldata('tokenURI(uint256)', tokenId) });
  const u = parseTokenUri(decodeStr(r.ok));
  if (u.block) { out.block.push(u.block); return; }
  let meta = u.meta;
  if (!meta) {
    const m = await fetchMeta(u.urls);
    if (m.outcome === 'notjson') { out.block.push('tokenURI 打开了但不是 NFT 资料（JSON）'); return; }
    if (m.outcome === 'bad') { out.block.push('tokenURI 打不开（链接不存在）'); return; }
    if (!m.meta) { out.warn.push('tokenURI 暂时读不到（网关限流 / 超时 / 出错），图片没核实'); return; }
    meta = m.meta;
  }
  const im = imageOf(meta);
  if (im.block) { out.block.push(im.block); return; }
  out.info.image = im.onchain ? '链上图' : im.image.slice(0, 120);
  if (im.urls) {
    const k = await probeImage(im.urls);
    if (k === 'bad') { out.block.push('图片打不开或不是图片'); return; }
    if (k === 'unavailable') out.warn.push('图片暂时读不到（网关限流 / 超时 / 出错），没核实');
  }
  const idx = readJson('nft-images.json', {});
  const others = noteImage(idx, imageKey(im.image), ca);
  if (others.length) out.block.push(`同一张图已经在 ${others.length} 个别的合约用过（${others.slice(0, 2).join('、')}），像拿别人的图开盘`);
  if (save) writeJson('nft-images.json', idx);
}

async function sameCodeCheck(ca, out, save) {
  const now = Date.now(), cache = readJson('devcheck-codes.json', {});
  const seen = recentCandidateCas(tailLines('radar-candidates.jsonl', 5000), now);
  seen.set(ca, cache[ca]?.seen && now - Date.parse(cache[ca].seen) < 86400_000 ? cache[ca].seen : new Date(now).toISOString());
  let n = 0;
  for (const [c, ts] of seen) {
    const e = cache[c] ||= { seen: ts };
    if (Date.parse(ts) < Date.parse(e.seen || ts)) e.seen = ts;
    if (e.code === undefined && (c === ca || n++ < MAX_NEW_CODES)) e.code = await codeKey(c).catch(() => null);
  }
  cache[ca].seen = seen.get(ca);
  for (const [c, v] of Object.entries(cache)) if (now - Date.parse(v.seen || 0) > 7 * 86400_000) delete cache[c];   // 只留 7 天
  if (save) writeJson('devcheck-codes.json', cache);
  const same = sameCodeWithin(cache, ca, now);
  out.info.sameCode24h = same.length;
  if (same.length >= SAME_CODE_LIMIT) out.block.push(`同一份合约代码 24 小时内出现了 ${same.length} 个（${same.filter(c => c !== ca).slice(0, 2).join('、')}…），像批量部署掏钱`);
}

// → { contract, verdict: '拦' | '可打，但有提醒' | '通过', block: [], warn: [], info: {} }
// save=false：不写缓存和图片索引（测试 / 试运行用）
export async function devCheck(contract, { save = true } = {}) {
  const ca = String(contract).toLowerCase();
  const out = { contract: ca, block: [], warn: [], info: {} };
  if ((await rpc('eth_getCode', [ca, 'latest']) || '0x').length <= 2) { out.block.push('这个地址没有合约代码'); out.verdict = verdictOf(out); return out; }
  const T = thresholds(); out.info.thresholds = { paidProgress: T.paidProgress, minSenders: T.minSenders, minSendersDrained: T.minSendersDrained };
  out.info.name = decodeStr((await ethCall({ to: ca, data: '0x' + sel('name()') })).ok).replace(/[\u0000-\u001f\u007f-\u009f<>]/g, ' ').slice(0, 60);
  const ow = (await ethCall({ to: ca, data: '0x' + sel('owner()') })).ok;
  const owner = ow && ow.length >= 66 ? addrOf(ow.slice(0, 66)) : null;
  out.info.owner = owner && owner !== '0x' + '0'.repeat(40) ? owner : null;

  await sameCodeCheck(ca, out, save);

  // 近 WINDOW_BLOCKS 块的铸造（Transfer from 0x0），按交易发起人算人数
  const head = Number(await rpc('eth_blockNumber', []));
  const logs = await getLogs({ address: ca, topics: [TRANSFER, ZERO64] }, Math.max(0, head - WINDOW_BLOCKS + 1), head);
  const is721 = ((await ethCall({ to: ca, data: '0x' + sel('supportsInterface(bytes4)') + '80ac58cd'.padEnd(64, '0') })).ok || '').endsWith('1');
  const hashes = [...new Set(logs.map(l => l.transactionHash))].slice(-MAX_TX);
  const st = senderStats(logs, await txFroms(hashes), is721);
  const bnb = Number(BigInt(await rpc('eth_getBalance', [ca, 'latest']))) / 1e18;
  const usdt = Number(big((await ethCall({ to: USDT, data: '0x' + sel('balanceOf(address)') + word(ca) })).ok)) / 1e18;
  const drained = isDrained(bnb, usdt);
  Object.assign(out.info, { mintLogs: logs.length, senders: st.senders, recipients: st.recipients, held: { bnb: +bnb.toFixed(4), usdt: +usdt.toFixed(2) },
    topSender: st.top ? { address: st.top.address, share: +st.top.share.toFixed(3) } : null, is721 });
  const j = judgeMinting(st, T, { drained, owner: out.info.owner });
  out.block.push(...j.block); out.warn.push(...j.warn);

  if (is721) {   // 拿最近一张铸出来的看图
    const last = logs[logs.length - 1];
    if (last?.topics?.[3]) await nftImageCheck(ca, BigInt(last.topics[3]), out, save).catch(e => out.warn.push('图片检查出错：' + String(e.message).slice(0, 60)));
    else out.warn.push('近期没有铸造记录，图片没检查');
  }
  out.verdict = verdictOf(out);
  return out;
}
