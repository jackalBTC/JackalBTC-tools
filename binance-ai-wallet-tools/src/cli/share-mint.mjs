#!/usr/bin/env node
// 付费按份铸币（按份付 BNB 买发射项目的份额，铸满才开池）：先过五道关口，全过才让所有钱包按预算自动参与；任何一道不过只出简报。
//
// 用法:
//   node src/cli/share-mint.mjs <项目id> <铸造合约> --qty <份数> [--fn "mint(uint256)"] [--args "{qty}"]
//        [--sold-fn "totalMinted()"] [--cap-fn "maxShares()"] [--cap <份数>] [--token <代币合约>] [--pay bnb|usdt] [--dry]
//     --qty      每个钱包想买几份（1–50），超预算的钱包自动减少，减到 0 跳过
//     --fn/--args 铸造函数和参数，原样交给 mint.mjs（同样的写法）
//     --sold-fn / --cap-fn  读进度用的无参数只读函数；不写就试常见名字（totalMinted / totalSold / sold / minted … 和 maxShares / cap / MAX_SUPPLY …）
//     --cap      直接给开池所需份数（优先于 --cap-fn）
//     --token    代币合约；不写就用台账 data/projects.json 里该项目的 contracts.token
//     --pay      付款币种，默认 bnb。usdt 要先授权代币，本工具的自动流程不做授权，所以 usdt 一律只出简报
//     --dry      只评估、不写日志、不发交易；五关全过时再用 mint-all --dry 算每个钱包的计划
// 五道关口（纯逻辑和测试在 src/lib/sharemint.mjs）：
//   ① 进度 ≥ 本机随机门槛（data/thresholds.json 的 paidProgress）；读不准、>100% 都算不过
//   ② 每个钱包在这个项目的累计花费 ≤ config.shareMint.budgetUsd（BNB 按 Chainlink 折算，之前花过的从 data/spend.jsonl 算）
//   ③ 铸造合约和代币合约都在 Sourcify 验证了源码
//   ④ 台账该项目的 review 四项都是 true（AI 读完源码后如实填写：钱留在合约里、没人能随意提走、代币铸造入口为 0 或已锁、LP 打到销毁地址）
//   ⑤ 防骗检查不是「拦」（没跑完按不通过）
// 每道关口写一条 verify 日志；有不过的写 brief、退出码 2，不发任何交易。
// 全过但 config.shareMint.enabled=false：写 brief、退出码 3，不发交易。
// 全过且开关打开：签一张 30 分钟的通行证（data/share-mint-gate.json），调用 mint-all 让所有钱包（先主后副）按份铸币；
// 每个钱包仍然走 mint.mjs 的全部检查：会话核对、按报价模拟、币安预演把关（除了付给本合约的 BNB 不能有任何扣款、授权、风险提示）、锁、记账。
// 退出码：0 全部钱包成功；1 参数错；2 关口没过；3 开关没开；4 有钱包没打成；5 日志写不进去。
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config, readJson, writeJson, dataFile } from '../lib/config.mjs';
import { batch, sel, isAddr, bnbUsd, sourcifyAbi } from '../lib/chain.mjs';
import { devCheck, thresholds } from '../lib/devcheck.mjs';
import { logEvent } from '../lib/events.mjs';
import { readWallets } from '../lib/wallets.mjs';
import { SOLD_FNS, SOLD_FALLBACK, CAP_FNS, FN_RE, uintOf, pickProgress, spentUsdFor, evaluateGates } from '../lib/sharemint.mjs';

const USAGE = '用法: node src/cli/share-mint.mjs <项目id> <铸造合约> --qty <份数> [--fn "mint(uint256)"] [--args "{qty}"] [--sold-fn "totalMinted()"] [--cap-fn "maxShares()"] [--cap <份数>] [--token <代币合约>] [--pay bnb|usdt] [--dry]';
const MINT_ALL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mint-all.mjs');
const GATE_FILE = 'share-mint-gate.json';

// ---------- 参数（严格，拼错不忽略） ----------
const VAL = ['--qty', '--fn', '--args', '--sold-fn', '--cap-fn', '--cap', '--token', '--pay'];
const argv = process.argv.slice(2), pos = [], o = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VAL.includes(a)) { if (argv[i + 1] == null) { console.error(`${a} 后面缺少值\n${USAGE}`); process.exit(1); } o[a.slice(2)] = argv[++i]; }
  else if (a === '--dry') o.dry = true;
  else if (a.startsWith('-')) { console.error(`不认识的参数 ${a}（为了安全，拼错的参数不会被忽略）\n${USAGE}`); process.exit(1); }
  else pos.push(a);
}
const [pid, to] = pos, DRY = !!o.dry, qty = Number(o.qty), pay = (o.pay || 'bnb').toLowerCase();
const bad = [];
if (pos.length !== 2) bad.push('要两个位置参数：项目 id 和铸造合约');
if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(pid || '')) bad.push('项目 id 只能用字母数字 - _');
if (!isAddr(to)) bad.push('铸造合约要完整 0x 地址');
if (!Number.isInteger(qty) || qty < 1 || qty > 50) bad.push('--qty 是 1–50 的整数');
if (o['sold-fn'] && !FN_RE.test(o['sold-fn'])) bad.push('--sold-fn 只支持无参数函数，例如 "totalMinted()"');
if (o['cap-fn'] && !FN_RE.test(o['cap-fn'])) bad.push('--cap-fn 只支持无参数函数，例如 "maxShares()"');
if (o.cap != null && !(/^\d{1,30}$/.test(o.cap) && BigInt(o.cap) > 0n)) bad.push('--cap 是正整数（开池所需份数）');
if (o.token && !isAddr(o.token)) bad.push('--token 要完整 0x 地址');
if (!['bnb', 'usdt'].includes(pay)) bad.push('--pay 只能是 bnb 或 usdt');
if (bad.length) { console.error('参数不对：' + bad.join('；') + '\n' + USAGE); process.exit(1); }

const SM = config.shareMint || { enabled: false, budgetUsd: 30 };
const log = (step, detail) => {
  if (DRY) { console.log(`[空跑 ${step}] ${detail}`); return; }
  try { logEvent(pid, step, String(detail).slice(0, 900), { contract: to }); }
  catch (e) { console.error('❌ 日志写入失败：' + e.message); process.exit(5); }
};

// ---------- 读数据 ----------
const proj = (readJson('projects.json', []) || []).find(p => p?.id === pid) || null;
const ledgerToken = proj?.contracts && isAddr(proj.contracts.token) ? proj.contracts.token : null;
if (o.token && ledgerToken && o.token.toLowerCase() !== ledgerToken.toLowerCase()) { console.error(`--token ${o.token} 和台账里的 contracts.token ${ledgerToken} 不一致，先核实`); process.exit(1); }
const token = o.token || ledgerToken;

// 进度：同一批 eth_call 读所有候选函数
const soldSigs = o['sold-fn'] ? [o['sold-fn']] : [...SOLD_FNS, SOLD_FALLBACK];
const capSigs = o.cap != null ? [] : o['cap-fn'] ? [o['cap-fn']] : CAP_FNS;
let progress;
try {
  const res = await batch([...soldSigs, ...capSigs].map(s => [to, '0x' + sel(s)]));
  const reads = { sold: soldSigs.map((sig, i) => ({ sig, value: uintOf(res[i]) })), cap: capSigs.map((sig, i) => ({ sig, value: uintOf(res[soldSigs.length + i]) })) };
  progress = pickProgress(reads, { capOverride: o.cap != null ? BigInt(o.cap) : null });
} catch (e) { progress = { ok: false, reason: 'RPC 读不了：' + String(e.message || e).slice(0, 80) }; }

const T = thresholds();
const usdPerBnb = await bnbUsd().catch(() => null);
let wallets;
try { wallets = readWallets(); } catch (e) { console.error(e.message); process.exit(1); }
const mainId = wallets.find(w => w.main).id;
let ledger = [];
try { ledger = fs.readFileSync(dataFile('spend.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
catch (e) { if (e.code !== 'ENOENT') { console.error('花费账本 data/spend.jsonl 读不了：' + e.message + '（算不出已花多少，不继续）'); process.exit(1); } }
const ws = wallets.map(w => ({ id: w.id, spentUsd: spentUsdFor(ledger, { pid, contracts: [to], walletId: w.id, mainId, usdPerBnb }) }));
const [srcMint, srcToken] = await Promise.all([sourcifyAbi(to), token ? sourcifyAbi(token) : Promise.resolve({ match: null })]);
const dc = await devCheck(to, { save: !DRY }).catch(e => ({ error: String(e.message || e) }));

// ---------- 五道关口 ----------
const r = evaluateGates({ progress, threshold: T.paidProgress, pay, usdPerBnb, budgetUsd: SM.budgetUsd, wallets: ws,
  verified: { mint: srcMint.match, token: srcToken.match, tokenAddr: token }, review: proj?.review, contract: to, token, devcheck: dc });
if (!proj) r.gates.find(g => g.id === 4).detail = '台账 data/projects.json 里没有这个项目（先建条目、读源码、写 review）';
for (const g of r.gates) log('verify', `按份铸币关口 ${g.id}「${g.name}」${g.ok ? '通过' : '不通过'}：${g.detail}`);

if (!r.pass) {
  log('brief', `付费按份铸币不自动参与：${r.failed.join('、')}没过。${r.gates.filter(g => !g.ok).map(g => `${g.name}：${g.detail}`).join('｜')}`);
  console.log(JSON.stringify({ project: pid, pass: false, failed: r.failed }));
  process.exit(2);
}
if (SM.enabled !== true) {
  log('brief', `付费按份铸币五关全过（进度 ${progress.pct}%），但 config.shareMint.enabled 没打开，只出简报、不发交易`);
  console.log(JSON.stringify({ project: pid, pass: true, enabled: false }));
  process.exit(3);
}

// ---------- 全过：签通行证，所有钱包按份铸币 ----------
const pass = crypto.randomBytes(16).toString('hex');
if (!DRY) {
  writeJson(GATE_FILE, { token: pass, pid, contract: to, at: new Date().toISOString(), budgetUsd: SM.budgetUsd });
  process.on('exit', () => { try { if (readJson(GATE_FILE, null)?.token === pass) fs.rmSync(dataFile(GATE_FILE)); } catch {} });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));
}
log('verify', `按份铸币五关全过，所有钱包（${wallets.map(w => w.id).join('、')}）各 ${qty} 份、每钱包每项目预算 $${SM.budgetUsd}，交给 mint-all`);
const args = [MINT_ALL, pid, to, String(qty), '--share-mint', pass];
if (o.fn) args.push('--fn', o.fn);
if (o.args) args.push('--args', o.args);
if (DRY) args.push('--dry');
const code = await new Promise(res => {
  const p = spawn(process.execPath, args, { stdio: 'inherit' });
  p.on('close', c => res(c ?? 1));
});
console.log(`按份铸币 ${pid}：${code === 0 ? '所有钱包完成' : '有钱包没打成（见上面汇总）'}`);
process.exit(code === 0 ? 0 : 4);
