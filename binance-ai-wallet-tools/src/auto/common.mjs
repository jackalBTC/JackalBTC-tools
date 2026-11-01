// 后台自动任务共用的小工具：日志、写项目动态（Telegram 会推）、和 mint 共用的锁、写操作日志。
import fs from 'node:fs';
import { readJson, writeJson, dataFile, DATA } from '../lib/config.mjs';
import { logEvent } from '../lib/events.mjs';
import { multiWallet } from '../lib/wallets.mjs';

export const DRY = process.argv.includes('--dry');
const clean = v => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ');
export const log = (...a) => console.log(new Date().toLocaleString('zh-CN', { hour12: false }), ...a.map(clean));

// 写一条项目动态到 data/news.json（Telegram 机器人按等级推送：重要 / 机会 / 注意 / 一般）
export function addNews(project, level, title, summary, action = '') {
  if (DRY) { log('[试运行] NEWS', level, title, '—', summary); return; }
  const n = readJson('news.json', []);
  n.push({ ts: new Date().toISOString(), project: String(project || 'auto'), account: '', level, title, summary, action, url: '' });
  writeJson('news.json', n);
}

// 写操作日志（data/events.jsonl）。只有配置了多钱包才带 wallet 字段，和 mint 一致
export function event(project, step, detail, opt = {}, w = null) {
  if (DRY) { log('[试运行] EVENT', project, step, detail); return; }
  try { logEvent(project, step, detail, { ...opt, ...(w && multiWallet() ? { wallet: w.id } : {}) }); }
  catch (e) { log('ERR 日志写入失败', e.message); }
}

// 和 mint 共用 data/.mint.lock：同一时间只有一个会发交易的进程。拿不到锁就跳过这一轮
const LOCK = dataFile('.mint.lock');
export async function withLock(fn) {
  if (DRY) return fn();
  fs.mkdirSync(DATA, { recursive: true });
  try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 15 * 60_000) fs.rmSync(LOCK, { force: true }); } catch {}
  try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); }
  catch { log('SKIP 有 mint 在跑（data/.mint.lock），下一轮再做'); return null; }
  try { return await fn(); }
  finally { try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.rmSync(LOCK); } catch {} }
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
