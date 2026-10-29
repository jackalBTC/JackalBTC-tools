// 批量模板识别：同一个模板换个名字反复部署的项目（常见于小号连发的「免费 mint」），按对外函数集合比对。
// 指纹存在 data/fingerprints.json：{ "<keccak(code)>": ["0x合约", …] }。代理壳等很短的代码不参与比较。
import { readJson, writeJson } from './config.mjs';
import { codeFingerprint } from './chain.mjs';

const FILE = 'fingerprints.json';
const load = () => readJson(FILE, {});

// 记录一个合约的指纹，返回指纹（或 null）
export async function remember(addr) {
  const fp = await codeFingerprint(addr);
  if (!fp) return null;
  const db = load(), list = db[fp] ||= [];
  if (!list.includes(addr.toLowerCase())) { list.push(addr.toLowerCase()); writeJson(FILE, db); }
  return fp;
}

// 把持仓 / 台账里还没算过指纹的合约补上（每次最多 n 个，避免一次请求太多）
export async function backfill(addresses, n = 20) {
  const db = load(), known = new Set(Object.values(db).flat());
  for (const a of addresses.filter(a => /^0x[0-9a-fA-F]{40}$/.test(a) && !known.has(a.toLowerCase())).slice(0, n)) await remember(a);
}

// 和这个合约对外函数完全相同的其他合约（不含自己）
export async function sameCodeAs(addr) {
  const fp = await remember(addr);
  if (!fp) return [];
  return (load()[fp] || []).filter(a => a !== addr.toLowerCase());
}
