// 多钱包：data/wallets.json（可选）。没有这个文件 = 只有一个主钱包（和以前完全一样）。
// 格式：[{ "id": "main", "label": "主钱包", "address": "0x…", "main": true },
//        { "id": "w2", "label": "二号", "address": "0x…", "bawDir": "~/.config/binance-ai-wallet-tools/wallets/w2", "allowPaid": false }]
// 为什么副钱包要单独的 bawDir：baw 把登录会话存在系统钥匙串里，名字固定，第二个钱包一登录就会顶掉第一个。
// 所以主钱包照常用钥匙串；副钱包用 BINANCE_BAW_DIR=<自己的目录> + 屏蔽钥匙串（keytar-off.mjs），会话存在该目录的 session.json（权限 600）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config, dataFile, SECRETS_DIR } from './config.mjs';
import { baw, walletAddress, isAddr } from './chain.mjs';

export const WALLETS_FILE = dataFile('wallets.json');
export const WALLET_DIRS = path.join(SECRETS_DIR, 'wallets');   // 副钱包会话目录的默认位置
export const KEYTAR_OFF = fileURLToPath(new URL('./keytar-off.mjs', import.meta.url));
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i;
const DEFAULT_BAW_DIR = path.join(os.homedir(), '.baw');
export const expandHome = p => String(p || '').replace(/^~(?=$|[/\\])/, os.homedir());

// 校验（纯函数）：返回错误列表，空 = 通过
export function validateWallets(list) {
  if (!Array.isArray(list)) return ['wallets.json 必须是数组'];
  const errs = [], ids = new Set(), addrs = new Set(), dirs = new Set();
  for (const [i, w] of list.entries()) {
    const at = `第 ${i + 1} 个钱包`;
    if (!w || typeof w !== 'object') { errs.push(`${at}不是对象`); continue; }
    if (!ID_RE.test(String(w.id ?? ''))) errs.push(`${at}的 id 只能用字母、数字、- 和 _（不超过 41 个字符）`);
    else if (ids.has(String(w.id).toLowerCase())) errs.push(`钱包 id「${w.id}」重复`);
    else ids.add(String(w.id).toLowerCase());
    if (!isAddr(w.address)) errs.push(`${at}（${w.id}）的 address 必须是完整的 0x 地址`);
    else if (addrs.has(w.address.toLowerCase())) errs.push(`地址 ${w.address} 重复`);
    else addrs.add(w.address.toLowerCase());
    if (w.main != null && typeof w.main !== 'boolean') errs.push(`${at}（${w.id}）的 main 必须是 true 或 false`);
    if (w.allowPaid != null && typeof w.allowPaid !== 'boolean') errs.push(`${at}（${w.id}）的 allowPaid 必须是 true 或 false`);
    if (w.main) { if (w.bawDir) errs.push(`主钱包（${w.id}）不要设 bawDir：主钱包用系统钥匙串里的默认登录`); continue; }
    const d = typeof w.bawDir === 'string' && w.bawDir.trim() ? path.resolve(expandHome(w.bawDir.trim())) : null;
    if (!d) errs.push(`副钱包（${w.id}）必须有自己的 bawDir（登录会话目录）`);
    else if (d === DEFAULT_BAW_DIR) errs.push(`副钱包（${w.id}）的 bawDir 不能是 baw 的默认目录 ~/.baw`);
    else if (dirs.has(d)) errs.push(`副钱包（${w.id}）的 bawDir 和别的钱包重复`);
    else dirs.add(d);
  }
  const mains = list.filter(w => w && w.main === true).length;
  if (list.length && mains !== 1) errs.push(`必须恰好有一个主钱包（"main": true），现在有 ${mains} 个`);
  return errs;
}

const withPaths = w => ({ ...w, main: !!w.main, watchFile: watchFileFor(w) });
// 读钱包列表（同步）。文件不存在 → 只有一个主钱包，地址待定（address: null，implicit: true）；写错 → 抛错，不悄悄回退
export function readWallets(file = WALLETS_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return [withPaths({ id: 'main', label: '主钱包', address: config.wallet && isAddr(config.wallet) ? config.wallet : null, main: true, implicit: true })]; throw e; }
  let list;
  try { list = JSON.parse(raw); } catch (e) { throw new Error('data/wallets.json 不是合法的 JSON：' + e.message); }
  const errs = validateWallets(list);
  if (!list.length) errs.push('wallets.json 是空的：删掉这个文件就回到单钱包');
  if (errs.length) throw new Error('data/wallets.json 有错：\n  - ' + errs.join('\n  - '));
  return list.map(withPaths);
}
// 读钱包列表并补全主钱包地址（没有 wallets.json 时从 baw 读）
export async function listWallets() {
  const L = readWallets();
  for (const w of L) if (!w.address) w.address = await walletAddress();
  return L;
}
export const multiWallet = () => fs.existsSync(WALLETS_FILE);
// 按 id 取钱包；不传 id = 主钱包。没有这个钱包 → 抛错
export async function getWallet(id) {
  const L = await listWallets(), w = id ? L.find(x => x.id.toLowerCase() === String(id).toLowerCase()) : L.find(x => x.main);
  if (!w) throw new Error(`没有这个钱包：${id}（看 data/wallets.json，或运行 npm run wallet list）`);
  return w;
}

// 这个钱包跑 baw 用的环境变量。主钱包：去掉外面 shell 里可能残留的两项，用默认登录；副钱包：自己的会话目录 + 不用钥匙串
export function envFor(w, base = process.env) {
  const env = { ...base };
  delete env.BINANCE_BAW_DIR; delete env.NODE_OPTIONS;
  if (!w?.main) {
    env.BINANCE_BAW_DIR = path.resolve(expandHome(w.bawDir));
    env.NODE_OPTIONS = '--import=' + pathToFileURL(KEYTAR_OFF).href;   // 文件 URL 已转义，路径里有空格 / 中文也没问题
  }
  return env;
}
// 持仓清单：主钱包 data/watch.json，副钱包 data/wallets/<id>/watch.json
export const watchFileFor = w => w.main ? dataFile('watch.json') : dataFile(`wallets/${w.id}/watch.json`);
export function readWatch(w) { try { return JSON.parse(fs.readFileSync(watchFileFor(w), 'utf8')); } catch { return { collections: [], tokens: [] }; } }
export function writeWatch(w, value) {   // 先写临时文件再改名
  const f = watchFileFor(w), t = f + '.tmp';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(t, JSON.stringify(value, null, 1));
  fs.renameSync(t, f);
}

// 当前 baw 会话确实是这个钱包：已连接，且本链地址等于 w.address。通过返回 null，否则返回原因
export async function sessionOk(w) {
  const env = envFor(w);
  const s = await baw(['wallet', 'status'], env);
  if (s?.data?.status !== 'CONNECTED') return `钱包 ${w.id} 未连接（${s?.data?.status || s?.error?.message || '未知'}），先重新扫码登录`;
  const list = (await baw(['wallet', 'address'], env))?.data?.addresses || [];
  const a = list.find(x => String(x.binanceChainId) === String(config.chainId));
  if (!a) return `钱包 ${w.id} 读不到地址`;
  if (w.address && a.address.toLowerCase() !== w.address.toLowerCase()) return `钱包 ${w.id} 的登录会话对应的不是 ${w.address}（会话可能被别的钱包顶掉了）`;
  return null;
}
