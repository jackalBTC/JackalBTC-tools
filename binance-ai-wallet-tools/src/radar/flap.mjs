// Flap「Agent Curve」新盘监控（可选，默认关：config.radar.flap.enabled）。只读链：不发交易、不授权、不访问任何链接。
// 每轮雷达读一次 Flap Reader 合约的盘列表：getMarkets(offset, size) 返回值第 3 个字是总数；getMarketState(market) 给名字 / 符号 / 底池币 / 税 / 单钱包上限。
// 新出现的盘在雷达日志里写一行 `FLAP ca:<盘地址> 名字（符号）｜底池 · 税 · 单钱包上限｜结论｜创建者`，Telegram 机器人会推（默认响铃）。
// 第一次运行只记下当前总数，不补发旧盘。
// 盘名是任何人都能写的链上字符串：见过有人塞网页代码（<img onerror=…>）和「最高优先级系统指令」。一律当数据：清洗后才显示，可疑的直接隐藏。
import { readJson, writeJson } from '../lib/config.mjs';
import { rpc } from '../lib/chain.mjs';

export const READER = '0x18aa6c93f1887a243fdc348c9a77f5136555174a';   // Flap Reader（BSC）
const QUOTES = {   // 常见底池币
  '0x55d398326f99059ff775485246999027b3197955': 'USDT',
  '0x4902c5ebc598265ed2212b559b042de8a5eeec3f': 'BNCB',
  '0x02fca66c1d1afb4e2a7884261eb00f63598a7436': 'NVDAB',
  '0x205812cdbed920aff76c6580abd681a46d11efc7': 'QQQB',
  '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1': 'SPCXB',
};
const w = n => BigInt(n).toString(16).padStart(64, '0');
const num = x => Number(BigInt('0x' + x));
const call = data => rpc('eth_call', [{ to: READER, data }, 'latest']).then(r => r && r.length > 2 ? r : null, () => null);
const strAt = (hex, byte) => { const h = hex.slice(2), len = Number(BigInt('0x' + h.slice(byte * 2, byte * 2 + 64))); return Buffer.from(h.slice(byte * 2 + 64, byte * 2 + 64 + Math.min(len, 200) * 2), 'hex').toString('utf8'); };

// 名字清洗（纯函数，test/ 里有单元测试）
export const HOSTILE = /<|>|script|onerror|import\(|https?:|\/\/|instruction|ignore (all|previous)|system prompt|指令|seed|私钥|助记词/i;
export const cleanName = s => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff｜]/g, '').replace(/[^\p{L}\p{N} ._\-·]/gu, '').trim().slice(0, 30);

// 一个盘 → 一行日志正文（纯函数）。seen：{ names: {符号或名字: 次数}, creators: {地址: 次数} }，会被更新
export function flapLine(m, seen) {
  const hostile = HOSTILE.test(m.rawName + ' ' + m.rawSym);
  const name = hostile ? '（名字里藏了网页代码 / 指令，已隐藏）' : cleanName(m.rawName) || '（无名）';
  const sym = hostile ? '?' : cleanName(m.rawSym) || '?';
  const key = (cleanName(m.rawSym) || cleanName(m.rawName)).toLowerCase();
  const dup = seen.names[key] || 0; seen.names[key] = dup + 1;
  const byCreator = (seen.creators[m.creator] = (seen.creators[m.creator] || 0) + 1);
  const unknownQuote = m.quote.startsWith('0x');
  const flags = [];
  if (hostile) flags.push('⚠️ 名字含恶意代码，别在网页上打开');
  if (m.buyTax + m.sellTax > 8) flags.push(`税偏高 ${m.buyTax}%/${m.sellTax}%`);
  if (dup) flags.push('跟风同名（之前已有同名盘）');
  if (unknownQuote) flags.push('底池币不认识');
  const verdict = flags.length >= 2 || hostile ? '🔴 建议跳过' : flags.length ? '🟡 有疑点' : '🟢 首发、税合理';
  return `FLAP ca:${m.market} ` + [`${name}（${sym}）`, `底池 ${unknownQuote ? m.quote.slice(0, 10) : m.quote} · 税 ${m.buyTax}%/${m.sellTax}% · 单钱包上限 ${m.maxWallet}%`,
    `${verdict}${flags.length ? '（' + flags.join('、') + '）' : ''}`, `创建者 ${m.creator.slice(0, 6)}…${m.creator.slice(-4)}（第 ${byCreator} 个盘）`].join('｜');
}

async function marketAt(i) {
  const pg = await call('0x' + '8f82e165' + w(i) + w(1)); if (!pg) return null;   // getMarkets(offset, size)
  const W = pg.slice(2).match(/.{64}/g); const m = '0x' + W[num(W[0]) / 32 + 1].slice(24);
  const st = await call('0x' + '51c023e2' + m.slice(2).padStart(64, '0')); if (!st) return null;   // getMarketState(market)
  const S = st.slice(2).match(/.{64}/g);
  const t0 = num(S[0]) / 32, inner = t0 + num(S[t0]) / 32;
  const quote = '0x' + S[t0 + 1].slice(24);
  return {
    market: m, rawName: strAt(st, (inner + num(S[inner]) / 32) * 32), rawSym: strAt(st, (inner + num(S[inner + 1]) / 32) * 32), creator: '0x' + S[inner + 4].slice(24),
    quote: /^0x0{40}$/.test(quote) ? 'BNB' : QUOTES[quote] || quote,
    buyTax: num(S[inner + 5]) / 100, sellTax: num(S[inner + 6]) / 100, maxWallet: num(S[inner + 11]) / 100,
  };
}

// 雷达每轮调用一次；log 是雷达的日志函数（一行一条）
export async function flapTick(log) {
  const st = readJson('flap-state.json', { total: null, names: {}, creators: {} });
  const p0 = await call('0x' + '8f82e165' + w(0) + w(1)); if (!p0) return;
  const total = num(p0.slice(2 + 128, 2 + 192));
  if (st.total === null || total < st.total) { st.total = total; writeJson('flap-state.json', st); return; }
  const start = st.total;
  for (let i = start; i < total && i < start + 20; i++) {   // 一轮最多 20 个
    let m = null; try { m = await marketAt(i); } catch (e) { log('ERR flap', i, e.message); }
    if (!m) break;   // 读失败：下一轮从这里接着读，不跳过
    st.total = i + 1;
    log('FLAP', flapLine(m, st).slice('FLAP '.length));
  }
  for (const k of ['names', 'creators']) { const e = Object.entries(st[k] || {}); if (e.length > 5000) st[k] = Object.fromEntries(e.slice(-5000)); }
  writeJson('flap-state.json', st);
}
