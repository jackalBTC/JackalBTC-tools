#!/usr/bin/env node
// 统一铸造：输入合约和数量 → 读报价 → 套用花钱规则 → baw 预演把关 → 执行 → 回执 → 写日志、记花费、记持仓。
//
// 用法:
//   node src/cli/mint.mjs <项目id> <合约> <数量> [--fn "mint(uint256)"] [--args "{qty}"] [--wallet <钱包id>] [--free-only] [--dry]
//     --fn      铸造函数签名，默认 mint(uint256)；无参数的写 "mint()"
//     --args    逗号分隔的参数，{qty} 替换成数量，0x 开头按地址处理；默认 "{qty}"
//     --wallet  用 data/wallets.json 里的哪个钱包，默认主钱包；副钱包只打免费，除非它设了 "allowPaid": true
//     --dry     只算计划、不预演不执行、不写日志
//   不认识的参数会直接报错退出（防止把 --dry 拼错后真的执行）。
//
// 花钱规则（config.spending）：
//   - 免费张永远可以打；
//   - 付费需要 allowAutoPaid=true，且源码已验证（Sourcify）+ 台账里有官网或官推 + 单张 ≤ maxUnitUsd；
//   - 张数：这个钱包在这个合约的历史累计付费 ≤ maxPaidPerProject；金额：设了 maxDailyBnb 才看「当天所有钱包累计付费」（默认不设）。超出时自动减少付费张数，减到 0 就只打免费张；
//   - 付费合计 ≤ gasLikeBnb 时视同 gas，不看单价 / 张数上限（仍受上面的开关、验证、官源约束，设了每日上限也算进去）；
//   - 花费记在 data/spend.jsonl（只追加，多钱包时带 wallet 字段，没有的算主钱包），每日 / 每项目上限都按它算；同一时间只允许一个 mint 在跑（data/.mint.lock）。
// 钱包会话：开头、预演前、执行前各核对一次「baw 当前登录的就是这个钱包」，对不上就停。
// 预演把关（写死，不能配置关掉，缺字段一律按不通过处理）：
//   除了付给本合约、且不超过报价的 BNB 外不扣任何东西；没有授权 / 权限变化；没有任何风险提示（含风险地址）；不需要二次确认。
//   收到代币或 NFT 算正常。
import fs from 'node:fs';
import { config, readJson, dataFile, DATA } from '../lib/config.mjs';
import { calldata as cd, sel, word, rpc, ethCall, baw, waitReceipt, nftIdsReceived, bnbUsd, sourcifyAbi, agentIdOf } from '../lib/chain.mjs';
import { checkPreview, planPaid, pickQuoteFromAbi } from '../lib/rules.mjs';
import { backfill, sameCodeAs } from '../lib/clones.mjs';
import { logEvent } from '../lib/events.mjs';
import { getWallet, readWallets, readWatch, writeWatch, envFor, sessionOk, multiWallet } from '../lib/wallets.mjs';

const USAGE = '用法: node src/cli/mint.mjs <项目id> <合约> <数量> [--fn "mint(uint256)"] [--args "{qty}"] [--wallet <钱包id>] [--free-only] [--dry]';
const MAX_QTY = 50;

// ---------- 参数（严格） ----------
const argv = process.argv.slice(2), pos = [], o = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--fn' || a === '--args' || a === '--wallet') { if (argv[i + 1] == null) { console.error(`${a} 后面缺少值\n${USAGE}`); process.exit(1); } o[a.slice(2)] = argv[++i]; }
  else if (a === '--dry' || a === '--free-only') o[a.slice(2)] = true;
  else if (a.startsWith('-')) { console.error(`不认识的参数 ${a}（为了安全，拼错的参数不会被忽略）\n${USAGE}`); process.exit(1); }
  else pos.push(a);
}
const [pid, to, qtyS] = pos;
const FN = o.fn || 'mint(uint256)', ARGS = o.args, DRY = !!o.dry;
let qty = Number(qtyS);
if (pos.length !== 3 || !/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(pid || '') || !/^0x[0-9a-fA-F]{40}$/.test(to || '') || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
  console.error(`参数不对：项目 id 只能用字母数字 - _；合约要完整地址；数量是 1–${MAX_QTY} 的整数\n${USAGE}`); process.exit(1);
}
if (!/^[A-Za-z_][A-Za-z0-9_]*\((uint256|uint8|uint16|uint32|uint64|address)?(,(uint256|uint8|uint16|uint32|uint64|address))*\)$/.test(FN)) {
  console.error('--fn 只支持参数类型为整数 / 地址的函数签名，例如 mint(uint256)、mint(uint256,address)、mint()'); process.exit(1);
}
const S = config.spending;

// ---------- 钱包 ----------
let WAL, MAIN_ID;
try { WAL = await getWallet(o.wallet); MAIN_ID = readWallets().find(w => w.main).id; }
catch (e) { console.error(e.message); process.exit(1); }
const ENV = envFor(WAL), WTAG = multiWallet() ? WAL.id : null;   // 只有配置了多钱包才在日志 / 账本里写 wallet 字段
const FREE_ONLY = !!o['free-only'] || (!WAL.main && !WAL.allowPaid);   // 副钱包默认只打免费
if (!WAL.main && !WAL.allowPaid && !o['free-only']) console.log(`钱包 ${WAL.id} 是副钱包、没有设 allowPaid，只打免费张`);

// 日志：写不进去就停下（execute 之前），不让交易在没有记录的情况下发生
const log = (step, detail, opt = {}) => {
  if (DRY) { console.log(`[空跑 ${step}] ${detail}`); return; }
  try { logEvent(pid, step, detail, WTAG ? { ...opt, wallet: WTAG } : opt); }
  catch (e) { console.error('❌ 日志写入失败：' + e.message); if (step !== 'execute' && step !== 'confirm') process.exit(4); }
};
const stop = msg => { log('abort', msg, { contract: to }); console.log('中止：' + msg); process.exit(1); };
// 参数占位符：{qty} 数量、{wallet} 本钱包地址、{agentId} 本钱包的 Agent ID tokenId、{zero} 零地址；其余按字面（整数或 0x 地址）
let _agent;
const fill = async (p, q) => {
  const t = p.trim();
  if (t === '{qty}') return q;
  if (t === '{wallet}') return W;
  if (t === '{zero}') return '0x0000000000000000000000000000000000000000';
  if (t === '{agentId}') { _agent ??= await agentIdOf(W); if (!_agent) stop('这个钱包读不到 Agent ID'); return _agent.id; }
  if (/^0x[0-9a-fA-F]{40}$/.test(t) || /^\d+$/.test(t)) return t;
  console.error(`--args 里不认识的参数「${t}」：只能是 {qty} {wallet} {agentId} {zero}、整数或 0x 地址`); process.exit(1);
};
const data = async q => FN.endsWith('()') ? '0x' + sel(FN) : '0x' + sel(FN) + (await Promise.all((ARGS || '{qty}').split(',').map(p => fill(p, q)))).map(word).join('');

// ---------- 花费账本与锁 ----------
const SPEND = 'spend.jsonl', LOCK = dataFile('.mint.lock');
const spends = () => { try { return fs.readFileSync(dataFile(SPEND), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
if (!DRY) {
  fs.mkdirSync(DATA, { recursive: true });
  try {
    const age = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (age > 15 * 60_000) fs.rmSync(LOCK, { force: true });   // 超过 15 分钟的锁视为残留
  } catch {}
  try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); }
  catch { console.log('另一个 mint 正在运行（data/.mint.lock），等它结束再试。同一时间只允许一个，花费账本才不会算乱。'); process.exit(5); }
  process.on('exit', () => { try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.rmSync(LOCK); } catch {} });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));
}

// ---------- 0. 前置 ----------
{ const e = await sessionOk(WAL); if (e) { console.log(e + '，不打'); process.exit(2); } }
const W = WAL.address, me = W.toLowerCase();
if ((await rpc('eth_getCode', [to, 'latest'])).length <= 2) stop('目标地址没有合约代码');
const bal = Number(BigInt(await rpc('eth_getBalance', [W, 'latest']))) / 1e18;
if (bal < S.minBnbForTx) stop(`钱包 BNB 只有 ${bal.toFixed(5)}，低于 ${S.minBnbForTx}，先补 gas`);

// ---------- 1. 免费张数：直接用 value=0 模拟（不依赖各家报价函数的返回格式） ----------
const simOk = async (q, value) => !(await ethCall({ from: W, to, data: await data(q), value })).err;
let free = 0;
if (await simOk(qty, 0n)) free = qty;
else while (free < qty && await simOk(free + 1, 0n)) free++;

// ---------- 2. 报价：先按 ABI 找（返回值名字像 wei / cost / price），找不到再试常见函数名，最后试单价 × 张数 ----------
const src = await sourcifyAbi(to);
const verified = src.match;
const fromAbi = pickQuoteFromAbi(src.abi);
const GUESS = ['quote(address,uint256)', 'quoteMint(address,uint256)', 'priceFor(address,uint256)', 'quoteBnbFor(address,uint256)', 'quoteFor(address,uint256)'];
const UNIT = ['priceFor(address)', 'PRICE()', 'price()', 'mintPrice()', 'MINT_PRICE()', 'publicPrice()', 'cost()', 'mintFee()'];   // priceFor(address)：按本钱包报单价
let quoteSig = null;
async function totalOf(q) {
  if (q <= free) return 0n;
  if (fromAbi) {
    const vals = [];
    for (const a of fromAbi.args) vals.push(a === 'wallet' ? W : a === 'agentId' ? await fill('{agentId}', q) : q);
    const r = await ethCall({ from: W, to, data: '0x' + sel(fromAbi.sig) + vals.map(word).join('') });
    if (r.ok && r.ok.length >= 66 + 64 * fromAbi.out) { quoteSig = fromAbi.sig + '（ABI）'; return BigInt('0x' + r.ok.slice(2 + 64 * fromAbi.out, 66 + 64 * fromAbi.out)); }
  }
  for (const sig of GUESS) {
    const r = await ethCall({ from: W, to, data: cd(sig, W, q) });
    if (!r.ok || r.ok.length < 66) continue;
    const w = r.ok.slice(2).match(/.{64}/g).map(x => BigInt('0x' + x));
    quoteSig = sig + '（猜测）';
    return w.length > 1 && /^(quote|quoteMint)\(/.test(sig) && w[0] < 1000000n ? w[w.length - 1] : w[0];
  }
  for (const sig of UNIT) {
    const r = await ethCall({ from: W, to, data: '0x' + sel(sig) + (sig.includes('(address)') ? word(W) : '') });
    if (r.ok && r.ok.length >= 66) { quoteSig = sig + ' × 付费张数'; return BigInt(r.ok.slice(0, 66)) * BigInt(q - free); }
  }
  return null;
}
if (free === qty) quoteSig = 'value=0 模拟成功';

// ---------- 3. 花钱规则 ----------
const usdPerBnb = await bnbUsd().catch(() => null);
const proj = (readJson('projects.json', []) || []).find(p => p.id === pid) || {};
const official = !!(proj.site || proj.x);
const today = new Date().toDateString();
const ledger = spends();
const spentToday = ledger.filter(e => new Date(e.ts).toDateString() === today).reduce((s, e) => s + (Number(e.bnb) || 0), 0);
const paidSoFar = ledger.filter(e => String(e.contract).toLowerCase() === to.toLowerCase() && (e.wallet || MAIN_ID) === WAL.id).reduce((s, e) => s + (Number(e.paid) || 0), 0);
await backfill(readWallets().flatMap(w => readWatch(w).collections || []).map(c => c.contract)).catch(() => {});
const twins = await sameCodeAs(to).catch(() => []);
const clone = twins.length ? `与 ${twins.length} 个已知合约的对外函数完全相同，例如 ${twins[0]}` : null;
if (clone) log('verify', '疑似批量模板项目：' + clone + '，付费部分不打', { contract: to });
const r2 = await planPaid({ free, paid: qty - free, totalOf }, { spending: S, usdPerBnb, verified, official, freeOnly: FREE_ONLY, clone, spentToday, paidSoFar });
let { paid, total, notes } = r2;
qty = free + paid;
if (qty === 0) stop('不打：没有免费张，' + (notes.join('、') || '付费部分不符合规则'));
if (paid && !(await simOk(qty, total))) stop(`按报价 ${total} wei 模拟失败（可能额度已用完、未开放，或报价读错），不打`);
if (notes.length) log('verify', '花钱规则调整：' + notes.join('；'), { contract: to });
const plan = `共 ${qty} 张：免费 ${free} + 付费 ${paid}，合计 ${(Number(total) / 1e18).toFixed(6)} BNB${usdPerBnb ? `（≈$${(Number(total) / 1e18 * usdPerBnb).toFixed(2)}）` : ''}；报价函数 ${quoteSig || '无（value=0 模拟）'}；源码验证 ${verified || '否'}；官网/官推 ${official ? '有' : '无'}`;
log('verify', plan, { contract: to });
console.log(plan);
if (DRY) process.exit(0);

// ---------- 3. 预演把关（缺字段、看不懂的格式一律不通过） ----------
{ const e = await sessionOk(WAL); if (e) stop('预演前核对钱包会话失败：' + e); }
const pv = await baw(['contract-call', 'preview', '--binanceChainId', String(config.chainId), '--from', W, '--to', to, '--value', total.toString(), '--inputData', await data(qty)], ENV);
if (!pv.success) stop('预演失败：' + JSON.stringify(pv.error || pv).slice(0, 160));
const x = pv.data || {}, problems = checkPreview(x, { me, total });
if (problems.length) stop('预演不通过：' + problems.join('；'));
const gets = x.simulationResult.balanceChanges.filter(b => b.owner.toLowerCase() === me && Number(b.change) > 0).map(b => `${b.tokenType} ${String(b.contractAddress).slice(0, 8)}… +${b.change}`);
log('preview', `预演通过：只付 ${(Number(total) / 1e18).toFixed(6)} BNB；收到 ${gets.length} 项（${gets.slice(0, 3).join('; ')}${gets.length > 3 ? ' …' : ''}）`, { contract: to });

// ---------- 4. 执行 → 立刻记花费 → 回执 ----------
{ const e = await sessionOk(WAL); if (e) stop('执行前核对钱包会话失败：' + e); }
const ex = await baw(['contract-call', 'execute', '--requestId', x.requestId], ENV);
if (!ex.success) stop('执行失败：' + JSON.stringify(ex.error || ex).slice(0, 160));
const tx = ex.data?.txHash;
if (!tx) stop('执行未广播（可能需要在币安 App 里确认）：' + JSON.stringify(ex.data).slice(0, 160));
try { fs.appendFileSync(dataFile(SPEND), JSON.stringify({ ts: new Date().toISOString(), pid, contract: to, paid, bnb: Number(total) / 1e18, tx, ...(WTAG ? { wallet: WTAG } : {}) }) + '\n'); }
catch (e) { console.error(`❌❌ 交易已广播（${tx}），但花费账本写入失败：${e.message}。请手动把这笔记到 data/spend.jsonl，否则付费上限会算少。`); }
log('execute', `铸造 ${qty} 张（免费 ${free} + 付费 ${paid}）`, { tx, contract: to, value: `${(Number(total) / 1e18).toFixed(6)} BNB` });
const rc = await waitReceipt(tx);
if (!rc) { console.log('回执还没出来，稍后在 BscScan 查：' + tx); process.exit(3); }
const ids = nftIdsReceived(rc, to, W);
log('confirm', `回执 status=${rc.status}，到手 #${ids.join(',') || '-'}`, { tx, contract: to });

// ---------- 5. 记进持仓（主钱包 data/watch.json，副钱包 data/wallets/<id>/watch.json） ----------
if (rc.status === '0x1' && ids.length) {
  const w = readWatch(WAL); w.collections ||= [];
  let col = w.collections.find(c => c.contract.toLowerCase() === to.toLowerCase());
  if (!col) { col = { id: pid, name: proj.name || pid, contract: to, ids: [], image: 'tokenURI', market: { type: 'none' } }; w.collections.push(col); }
  col.ids = [...new Set([...(col.ids || []), ...ids])].sort((a, b) => a - b);
  const co = col.cost || { BNB: 0 };
  co.BNB = +((co.BNB || 0) + Number(total) / 1e18).toFixed(8); col.cost = co;
  writeWatch(WAL, w);
}
console.log(JSON.stringify({ wallet: WAL.id, status: rc.status, tx, ids, free, paid, bnb: Number(total) / 1e18 }));
