#!/usr/bin/env node
// 多钱包批量铸造：按 data/wallets.json 先用主钱包跑 mint.mjs，再依次换副钱包。每个钱包的规则、预演把关和 mint.mjs 完全一样。
//   - 副钱包默认只打免费（--free-only），加 --paid-all 才让副钱包也按花钱规则付费（钱包设了 allowPaid 的才会真的付）
//   - 钱包之间随机间隔 20–60 秒，避免同一时刻一起打
//   - 主钱包没打成：如果只是它自己的额度用完 / 付费到上限，副钱包照常继续；其他原因（预演不过、合约有问题、会话不对）整批停
//   - 有任何一个钱包没打成，最后以非 0 退出
// 用法: node src/cli/mint-all.mjs <项目id> <合约> <数量> [--fn ...] [--args ...] [--free-only] [--paid-all] [--skip-main] [--only id1,id2] [--dry]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWallets } from '../lib/wallets.mjs';

const USAGE = '用法: node src/cli/mint-all.mjs <项目id> <合约> <数量> [--fn "mint(uint256)"] [--args "{qty}"] [--free-only] [--paid-all] [--skip-main] [--only id1,id2] [--dry]';
const MINT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mint.mjs');

// ---------- 参数（严格，拼错不忽略） ----------
const argv = process.argv.slice(2), pos = [], o = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (['--fn', '--args', '--only'].includes(a)) { if (argv[i + 1] == null) { console.error(`${a} 后面缺少值\n${USAGE}`); process.exit(1); } o[a.slice(2)] = argv[++i]; }
  else if (['--free-only', '--paid-all', '--skip-main', '--dry'].includes(a)) o[a.slice(2)] = true;
  else if (a.startsWith('-')) { console.error(`不认识的参数 ${a}（为了安全，拼错的参数不会被忽略）\n${USAGE}`); process.exit(1); }
  else pos.push(a);
}
if (pos.length !== 3) { console.error(USAGE); process.exit(1); }   // 其余格式由 mint.mjs 校验

let wallets;
try { wallets = readWallets(); } catch (e) { console.error(e.message); process.exit(1); }
if (o.only) {
  const want = o.only.split(',').map(s => s.trim()).filter(Boolean), have = new Set(wallets.map(w => w.id.toLowerCase()));
  const bad = want.filter(id => !have.has(id.toLowerCase()));
  if (bad.length || !want.length) { console.error(`没有这些钱包：${bad.join(',') || '（空）'}（看 npm run wallet list）`); process.exit(1); }
  wallets = wallets.filter(w => want.some(id => id.toLowerCase() === w.id.toLowerCase()));
}
if (o['skip-main']) wallets = wallets.filter(w => !w.main);
wallets.sort((a, b) => b.main - a.main);   // 主钱包排第一
if (!wallets.length) { console.error('没有要打的钱包'); process.exit(1); }

// 子进程跑 mint.mjs，原样转发输出，返回退出码和最后一行
function run(w) {
  const args = [MINT, ...pos, '--wallet', w.id];
  if (o.fn) args.push('--fn', o.fn);
  if (o.args) args.push('--args', o.args);
  if (o['free-only'] || (!w.main && !o['paid-all'])) args.push('--free-only');
  if (o.dry) args.push('--dry');
  return new Promise(res => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; process.stdout.write(d); });
    p.stderr.on('data', d => { out += d; process.stderr.write(d); });
    p.on('close', code => { const lines = out.trim().split('\n'); res({ code, out, last: lines[lines.length - 1] || '' }); });
  });
}
// 「只是这个钱包自己打不了了」：没有免费张（额度用完 / 付费到上限减到 0）、合约报每钱包上限 / 已领过
const ownQuotaUsed = r => r.code === 1 && /没有免费张|已到上限|wallet limit|already (minted|claimed)/i.test(r.out);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
for (const w of wallets) {
  if (results.length && !o.dry) { const s = 20 + Math.floor(Math.random() * 41); console.log(`\n… 等 ${s} 秒再换下一个钱包`); await sleep(s * 1000); }
  console.log(`\n===== 钱包 ${w.id}${w.main ? '（主）' : ''} =====`);
  const r = await run(w);
  let res = null; try { res = JSON.parse(r.last); } catch {}
  const ok = r.code === 0 && (o.dry || res?.status === '0x1');
  results.push({ wallet: w.id, ok, ids: res?.ids || null, bnb: res?.bnb ?? null, msg: ok ? null : r.last.slice(0, 160) });
  if (w.main && !ok) {
    if (ownQuotaUsed(r)) { console.log('主钱包这次打不了（没有免费张 / 付费到上限 / 已领过），副钱包继续'); continue; }
    console.log('主钱包没打成，副钱包不跟（原因见上）'); break;
  }
}
console.log('\n汇总：');
for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.wallet}${r.ids?.length ? ' #' + r.ids.join(',') : ''}${r.msg ? '：' + r.msg : ''}`);
const skipped = wallets.length - results.length;
if (skipped) console.log(`  （${skipped} 个钱包没跑）`);
console.log(JSON.stringify({ summary: results }));
process.exit(results.length === wallets.length && results.every(r => r.ok) ? 0 : 1);
