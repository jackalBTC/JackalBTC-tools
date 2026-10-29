// 链上只读工具 + baw 调用封装。
import { execFile } from 'node:child_process';
import { keccak_256 } from '@noble/hashes/sha3';
import { config } from './config.mjs';

export const sel = sig => Buffer.from(keccak_256(Buffer.from(sig))).toString('hex').slice(0, 8);
export const word = v => (typeof v === 'string' && v.startsWith('0x') ? v.slice(2).toLowerCase() : BigInt(v).toString(16)).padStart(64, '0');
export const big = h => (h && h.length > 2 ? BigInt(h.slice(0, 66)) : 0n);
export const words = h => (h && h.length > 2 ? h.slice(2).match(/.{64}/g) || [] : []).map(x => BigInt('0x' + x));
export const addrOf = h => '0x' + String(h).replace(/^0x/, '').padStart(64, '0').slice(24).toLowerCase();
export const isAddr = a => /^0x[0-9a-fA-F]{40}$/.test(String(a));
export const decodeStr = h => { if (!h || h.length < 130) return ''; const n = parseInt(h.slice(66, 130), 16); return Buffer.from(h.slice(130, 130 + n * 2), 'hex').toString(); };
export const calldata = (sig, ...args) => '0x' + sel(sig) + args.map(word).join('');

export async function rpc(method, params, url = config.rpc.call) {
  let last;
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) { const e = new Error(j.error.message || 'rpc error'); e.data = j.error.data; e.rpc = true; throw e; }
      return j.result;
    } catch (e) { if (e.rpc) throw e; last = e; await new Promise(r => setTimeout(r, 800 * (t + 1))); }
  }
  throw last;
}

// 批量 eth_call：[[to, data], …] → 结果数组（失败的位置是 '0x'）。超过 20 个自动分批。
export async function batch(calls) {
  if (calls.length > 20) { const out = []; for (let i = 0; i < calls.length; i += 20) out.push(...await batch(calls.slice(i, i + 20))); return out; }
  if (!calls.length) return [];
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(config.rpc.call, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify(calls.map(([to, data], id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, 'latest'] }))) });
      const j = await r.json();
      if (!Array.isArray(j) || j.length !== calls.length) throw new Error('bad batch');
      return j.sort((a, b) => a.id - b.id).map(x => x.result || '0x');
    } catch { await new Promise(r => setTimeout(r, 800 * (t + 1))); }
  }
  throw new Error('RPC 暂时不可用');
}

export async function ethCall({ from, to, data, value = 0n }) {
  try { return { ok: await rpc('eth_call', [{ from, to, data, value: '0x' + BigInt(value).toString(16) }, 'latest']) }; }
  catch (e) { return { err: String(e.message || e).slice(0, 160), data: e.data }; }
}

export async function waitReceipt(tx, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const rc = await rpc('eth_getTransactionReceipt', [tx]).catch(() => null);
    if (rc) return rc;
  }
  return null;
}

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const nftIdsReceived = (rc, contract, to) => (rc?.logs || [])
  .filter(l => l.topics[0] === TRANSFER && l.topics.length === 4 && l.address.toLowerCase() === contract.toLowerCase() && addrOf(l.topics[2]) === to.toLowerCase())
  .map(l => Number(BigInt(l.topics[3])));

// Chainlink BNB/USD（BSC）
export async function bnbUsd() {
  const r = await rpc('eth_call', [{ to: '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE', data: '0xfeaf968c' }, 'latest']);
  return Number(BigInt('0x' + r.slice(66, 130))) / 1e8;
}

// Sourcify 是否已验证源码：'exact_match' / 'match' / null
export async function sourcifyMatch(addr) {
  try {
    const j = await (await fetch(`https://sourcify.dev/server/v2/contract/${config.chainId}/${addr}`, { signal: AbortSignal.timeout(20000) })).json();
    return j.match || null;
  } catch { return null; }
}

// Sourcify 上的 ABI。代理合约（EIP-1967）会顺带取实现合约的 ABI 合并进来。
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export async function sourcifyAbi(addr) {
  const get = async a => { try { const j = await (await fetch(`https://sourcify.dev/server/v2/contract/${config.chainId}/${a}?fields=abi`, { signal: AbortSignal.timeout(20000) })).json(); return { match: j.match || null, abi: j.abi || [] }; } catch { return { match: null, abi: [] }; } };
  const main = await get(addr);
  const slot = await rpc('eth_getStorageAt', [addr, IMPL_SLOT, 'latest']).catch(() => null);
  const impl = slot && BigInt(slot) !== 0n ? addrOf(slot) : null;
  if (!impl) return { ...main, impl: null };
  const im = await get(impl);
  return { match: main.match && im.match ? im.match : null, abi: [...main.abi, ...im.abi], impl };
}

// 合约「接口指纹」：从运行时字节码的函数分发表里取出全部 4 字节函数选择器，排序后取哈希。
// 批量模板项目换了名字、换了图，字节码会变，但对外函数一模一样；普通项目之间一般只有 80% 左右重合。
// 选择器太少（< 20，例如代理壳）返回 null，不参与比较。
export async function codeFingerprint(addr) {
  const code = await rpc('eth_getCode', [addr, 'latest']).catch(() => '0x');
  if (!code || code.length < 4) return null;
  const b = Buffer.from(code.slice(2), 'hex'), set = new Set();
  for (let i = 0; i < b.length; i++) {
    const op = b[i];
    if (op === 0x63 && b[i + 5] === 0x14) set.add(b.subarray(i + 1, i + 5).toString('hex'));   // PUSH4 <selector> EQ
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;   // 跳过 PUSH 的数据
  }
  if (set.size < 20) return null;
  return 'sel:' + Buffer.from(keccak_256(Buffer.from([...set].sort().join(',')))).toString('hex').slice(0, 32);
}

// Agent ID：注册表 handleOf(钱包) → tokenId = uint256(keccak256(handle))，并核对 ownerOf(tokenId) 就是这个钱包
export const AGENT_ID_REGISTRY = '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
export async function agentIdOf(wallet) {
  const h = await rpc('eth_call', [{ to: AGENT_ID_REGISTRY, data: calldata('handleOf(address)', wallet) }, 'latest']).catch(() => null);
  const handle = decodeStr(h);
  if (!handle) return null;
  const id = BigInt('0x' + Buffer.from(keccak_256(Buffer.from(handle))).toString('hex'));
  const o = await rpc('eth_call', [{ to: AGENT_ID_REGISTRY, data: calldata('ownerOf(uint256)', id) }, 'latest']).catch(() => null);
  return o && addrOf(o) === wallet.toLowerCase() ? { handle, id } : null;
}

// ---------- baw ----------
// env：用哪个钱包的登录会话（见 src/lib/wallets.mjs 的 envFor）；不传 = 当前环境（主钱包）
export function baw(args, env = null, timeout = 60000) {
  return new Promise(res => execFile('baw', [...args, '--json'], { timeout, maxBuffer: 8 << 20, ...(env ? { env } : {}) }, (e, out) => {
    try { res(JSON.parse(out)); } catch { res({ success: false, error: { message: String(e?.code === 'ENOENT' ? '没找到 baw 命令，请先安装币安 AI 钱包 CLI' : (e?.message || out)).slice(0, 200) } }); }
  }));
}
let _wallet = null;
export async function walletAddress() {
  if (config.wallet && isAddr(config.wallet)) return config.wallet;
  if (_wallet) return _wallet;
  const r = await baw(['wallet', 'address']);
  const list = r?.data?.addresses || [];
  const a = list.find(x => String(x.binanceChainId) === String(config.chainId)) || list.find(x => isAddr(x.address));
  if (!a) throw new Error('读不到钱包地址：' + (r?.error?.message || '请先 baw 登录'));
  return (_wallet = a.address);
}
