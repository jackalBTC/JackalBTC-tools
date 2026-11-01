// 付费按份铸币（share-mint）的纯逻辑：不联网、不读写文件。src/cli/share-mint.mjs 和 mint.mjs 调用，test/ 里有单元测试。
// 「按份铸币」：用户按份付 BNB 买一个发射项目的份额，铸满（已铸份数达到开池所需份数）才开流动性。
// 五道关口全部通过才允许自动参与（所有钱包），任何一道不过只出简报（brief）、不发交易：
//   ① 进度（已铸份数 / 开池所需份数）≥ 本机随机门槛 paidProgress（data/thresholds.json）
//   ② 每个钱包在这个项目累计花费 ≤ 预算（config.shareMint.budgetUsd，默认 30 美元；BNB 按 Chainlink 折算）
//   ③ 铸造合约和代币合约都在 Sourcify 验证了源码（代理合约要求实现合约也验证）
//   ④ AI 读过源码，在台账 data/projects.json 该项目的 review 里写了四个 true（见 checkReview）
//   ⑤ 防骗检查（src/lib/devcheck.mjs）不是「拦」；没跑完按不通过处理
// 改这里的任何行为，都要同步改测试、docs/security.md 和 README。

// ---------- 配置 ----------
// config.shareMint 的校验（config.mjs 调用）：可以不写；写了 enabled 必须是布尔，budgetUsd 必须是 (0, 10000] 的数字。返回错误列表
export function validateShareMint(sm) {
  if (sm == null) return [];
  if (typeof sm !== 'object' || Array.isArray(sm)) return ['shareMint 必须是对象'];
  const errs = [];
  if (typeof sm.enabled !== 'boolean') errs.push('shareMint.enabled 必须是 true 或 false（不要加引号）');
  if (!(typeof sm.budgetUsd === 'number' && Number.isFinite(sm.budgetUsd) && sm.budgetUsd > 0 && sm.budgetUsd <= 10000)) errs.push('shareMint.budgetUsd 必须是大于 0、不超过 10000 的数字（每个钱包每个项目最多花多少美元）');
  return errs;
}

// ---------- 进度 ----------
// 常见的只读函数名（无参数、返回一个 uint256）。totalSupply 只在别的「已铸」函数都读不到时才用。
export const SOLD_FNS = ['totalMinted()', 'totalSold()', 'sold()', 'minted()', 'mintedShares()', 'sharesSold()', 'soldShares()'];
export const SOLD_FALLBACK = 'totalSupply()';
export const CAP_FNS = ['maxShares()', 'MAX_SHARES()', 'totalShares()', 'cap()', 'hardCap()', 'MAX_SUPPLY()', 'maxSupply()'];
export const FN_RE = /^[A-Za-z_][A-Za-z0-9_]*\(\)$/;   // --sold-fn / --cap-fn 只接受无参数函数

// eth_call 的返回 → BigInt；只接受恰好一个 32 字节的字（结构体 / 多返回值 / 空返回都算读不到）
export function uintOf(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hex)) return null;
  return BigInt(hex);
}

// 从各候选函数的读数里挑出「已铸」和「上限」。reads：{ sold: [{ sig, value: BigInt|null }], cap: [...] }
// capOverride：用户用 --cap 给的数字（BigInt，优先）。返回 { ok, sold, cap, soldSig, capSig, reason }
// 拿不准就不通过：同类候选读出不同的数（例如 totalMinted 和 sold 不一致）→ 不通过。
export function pickProgress(reads, { capOverride = null } = {}) {
  const got = list => (list || []).filter(r => typeof r?.value === 'bigint');
  const distinct = list => [...new Set(list.map(r => r.value.toString()))];
  let soldList = got(reads?.sold).filter(r => r.sig !== SOLD_FALLBACK);
  if (!soldList.length) soldList = got(reads?.sold).filter(r => r.sig === SOLD_FALLBACK);
  if (!soldList.length) return { ok: false, reason: '读不到已铸份数（试过 ' + (reads?.sold || []).map(r => r.sig).join(' / ') + '）' };
  if (distinct(soldList).length > 1) return { ok: false, reason: '几个「已铸」函数读数不一致：' + soldList.map(r => `${r.sig}=${r.value}`).join('，') + '，用 --sold-fn 指定' };
  let cap, capSig;
  if (capOverride != null) { cap = BigInt(capOverride); capSig = '--cap'; }
  else {
    const capList = got(reads?.cap);
    if (!capList.length) return { ok: false, reason: '读不到开池所需份数（试过 ' + (reads?.cap || []).map(r => r.sig).join(' / ') + '），用 --cap-fn 或 --cap 指定' };
    if (distinct(capList).length > 1) return { ok: false, reason: '几个「上限」函数读数不一致：' + capList.map(r => `${r.sig}=${r.value}`).join('，') + '，用 --cap-fn 或 --cap 指定' };
    cap = capList[0].value; capSig = capList.map(r => r.sig).join('=');
  }
  const p = computeProgress(soldList[0].value, cap);
  return { ...p, soldSig: soldList.map(r => r.sig).join('='), capSig };
}

// 进度百分比 + 合理性检查。sold / cap 是 BigInt。超过 100%、上限为 0 → 不通过（多半是读错了函数或单位不一致）
export function computeProgress(sold, cap) {
  if (typeof sold !== 'bigint' || typeof cap !== 'bigint') return { ok: false, reason: '进度读数不是整数' };
  if (cap <= 0n) return { ok: false, sold, cap, reason: '开池所需份数是 0，读数不对' };
  if (sold < 0n) return { ok: false, sold, cap, reason: '已铸份数是负数，读数不对' };
  if (sold > cap) return { ok: false, sold, cap, reason: `已铸 ${sold} 超过上限 ${cap}（>100%），可能读错了函数或单位不一致` };
  const pct = Number(sold * 10000n / cap) / 100;   // 两位小数，不经过浮点除法丢精度
  return { ok: true, sold, cap, pct };
}

// ---------- 预算 ----------
// 这个钱包在这个项目已经花了多少美元：花费账本里 wallet 一致（没写 wallet 的算主钱包），且 pid 或合约一致的记录。
// 记录里有 usd 就用当时的 usd；老记录只有 bnb 的按现在的 BNB 价格折算；USDT 记录（usdt 字段）按 1:1。
export function spentUsdFor(ledger, { pid, contracts = [], walletId, mainId, usdPerBnb }) {
  const cs = new Set(contracts.map(c => String(c).toLowerCase()));
  let usd = 0;
  for (const e of ledger || []) {
    if (!e || (e.wallet || mainId) !== walletId) continue;
    if (e.pid !== pid && !cs.has(String(e.contract || '').toLowerCase())) continue;
    if (Number.isFinite(Number(e.usd)) && e.usd != null) usd += Number(e.usd);
    else {
      const bnb = Number(e.bnb) || 0, usdt = Number(e.usdt) || 0;
      if (bnb > 0 && !(usdPerBnb > 0)) return null;   // 有 BNB 花费但读不到价格：算不出来
      usd += bnb * (usdPerBnb || 0) + usdt;
    }
  }
  return usd;
}

// 按预算决定付费几份（async：totalOf(q) 返回 q 份一共多少 wei，可能是 null）。
// free：value=0 能拿的份数；want：想付费的份数。超预算一份份往下减，减到 0 就不付。
// 用户另外设了 spending.maxDailyBnb（所有钱包每天合计）时也照样遵守：maxDailyBnb / spentTodayBnb 传进来。
// 读不到 BNB 价格、读不到报价、已花的算不出来 → 0（不付）。返回 { paid, total, usd, notes }
export async function planShare({ free, want, totalOf }, { budgetUsd, spentUsd, usdPerBnb, maxDailyBnb = null, spentTodayBnb = 0 }) {
  const notes = [];
  if (want <= 0) return { paid: 0, total: 0n, usd: 0, notes };
  if (!(usdPerBnb > 0)) return { paid: 0, total: 0n, usd: 0, notes: ['读不到 BNB 价格，算不了预算'] };
  if (spentUsd == null || !Number.isFinite(spentUsd)) return { paid: 0, total: 0n, usd: 0, notes: ['算不出这个钱包已经花了多少'] };
  const left = budgetUsd - spentUsd;
  if (!(left > 0)) return { paid: 0, total: 0n, usd: 0, notes: [`这个钱包在这个项目已花 $${spentUsd.toFixed(2)}，已到上限 $${budgetUsd}`] };
  const usdOf = t => Number(t) / 1e18 * usdPerBnb;
  let paid = want, total = await totalOf(free + paid);
  while (paid > 0) {
    if (total === null) return { paid: 0, total: 0n, usd: 0, notes: ['读不到报价'] };
    const overDaily = maxDailyBnb != null && spentTodayBnb + Number(total) / 1e18 > maxDailyBnb;
    if (usdOf(total) <= left + 1e-9 && !overDaily) break;
    paid--;
    total = paid ? await totalOf(free + paid) : 0n;
  }
  const daily = maxDailyBnb != null ? `；今天所有钱包已付 ${spentTodayBnb.toFixed(5)} BNB，每日上限 ${maxDailyBnb}` : '';
  if (paid < want) notes.push(paid
    ? `付费从 ${want} 份减到 ${paid} 份（这个钱包在这个项目已花 $${spentUsd.toFixed(2)}，预算 $${budgetUsd}${daily}）`
    : `一份都放不进剩下的预算 $${left.toFixed(2)}（已花 $${spentUsd.toFixed(2)}，预算 $${budgetUsd}${daily}），已到上限`);
  return { paid, total: paid ? total : 0n, usd: paid ? usdOf(total) : 0, notes };
}

// ---------- 源码审查记录（AI 写在台账里，代码不自动判断） ----------
// review：{ fundsStay, noWithdraw, mintLocked, lpBurned, by, at, notes?, contract?, token? }
//   fundsStay  铸造收的钱留在合约里
//   noWithdraw 没有任何地址能随意把这笔钱提走
//   mintLocked 代币的铸造入口额度是 0 或已锁死
//   lpBurned   开池后 LP 打到销毁地址
// 四项都必须是 true（布尔，不是字符串）；by / at 必须写；写了 contract / token 就必须和这次的一致。返回问题列表，空 = 通过
export const REVIEW_KEYS = { fundsStay: '铸造的钱留在合约里', noWithdraw: '没有地址能随意提走', mintLocked: '代币铸造入口额度为 0 或已锁', lpBurned: 'LP 打到销毁地址' };
export function checkReview(review, { contract, token, now = Date.now() } = {}) {
  if (!review || typeof review !== 'object') return ['台账里没有 review（AI 读完源码后写）'];
  const errs = [];
  for (const [k, label] of Object.entries(REVIEW_KEYS)) if (review[k] !== true) errs.push(`${label}（${k}）不是 true`);
  if (typeof review.by !== 'string' || !review.by.trim()) errs.push('review.by 没写');
  const at = Date.parse(review.at);
  if (!Number.isFinite(at)) errs.push('review.at 不是有效时间');
  else if (at > now + 5 * 60_000) errs.push('review.at 在未来');
  if (review.contract != null && String(review.contract).toLowerCase() !== String(contract).toLowerCase()) errs.push('review.contract 和这次的铸造合约不一致');
  if (review.token != null && String(review.token).toLowerCase() !== String(token).toLowerCase()) errs.push('review.token 和这次的代币合约不一致');
  return errs;
}

// ---------- 五道关口 ----------
// 输入都是已经读好的数据：
//   progress   pickProgress 的结果；threshold 本机门槛 paidProgress（数字）
//   pay        'bnb' | 'usdt'；usdPerBnb；budgetUsd；wallets [{ id, spentUsd }]
//   verified   { mint, token, tokenAddr }（Sourcify 的 match 或 null）
//   review     台账里的 review；contract / token 地址
//   devcheck   devCheck 的结果 { verdict, block, warn }，或 { error }（没跑完）
// 返回 { pass, gates: [{ id, name, ok, detail }], failed: [name…] }
export function evaluateGates(x) {
  const gates = [];
  const add = (id, name, ok, detail) => gates.push({ id, name, ok: !!ok, detail });
  // ① 进度
  const p = x.progress;
  if (!p?.ok) add(1, '进度', false, '进度读不准：' + (p?.reason || '没读'));
  else if (!(Number.isFinite(x.threshold) && x.threshold > 0)) add(1, '进度', false, '本机门槛无效');
  else add(1, '进度', p.pct >= x.threshold, `已铸 ${p.sold} / ${p.cap}（${p.pct}%，${p.soldSig || ''} / ${p.capSig || ''}），${p.pct >= x.threshold ? '达到' : '未达到'}本机门槛`);
  // ② 预算
  {
    const why = [];
    if (x.pay !== 'bnb') why.push('USDT 付款要先授权代币，本工具的自动流程不做任何授权，只出简报');
    if (!(x.budgetUsd > 0)) why.push('预算无效');
    if (!(x.usdPerBnb > 0)) why.push('读不到 BNB 价格（Chainlink）');
    const ws = x.wallets || [];
    const left = ws.map(w => ({ id: w.id, left: w.spentUsd == null ? null : x.budgetUsd - w.spentUsd }));
    if (!ws.length) why.push('没有钱包');
    else if (!left.some(w => w.left != null && w.left > 0)) why.push('所有钱包在这个项目都已到预算上限（或算不出已花多少）');
    const detail = left.map(w => `${w.id} 剩 ${w.left == null ? '?' : '$' + Math.max(0, w.left).toFixed(2)}`).join('，');
    add(2, '预算', !why.length, (why.length ? why.join('；') + '｜' : '') + `每钱包每项目 $${x.budgetUsd}：${detail || '-'}`);
  }
  // ③ 源码验证
  {
    const v = x.verified || {}, why = [];
    if (!v.mint) why.push('铸造合约没在 Sourcify 验证');
    if (!v.tokenAddr) why.push('不知道代币合约地址（--token 或台账 contracts.token）');
    else if (!v.token) why.push('代币合约没在 Sourcify 验证');
    add(3, '源码验证', !why.length, why.length ? why.join('；') : `铸造合约 ${v.mint}，代币合约 ${v.token}`);
  }
  // ④ 源码审查记录
  {
    const errs = checkReview(x.review, { contract: x.contract, token: x.token, now: x.now });
    add(4, '源码审查', !errs.length, errs.length ? errs.join('；') : `四项都是 true（${x.review.by}，${String(x.review.at).slice(0, 16)}）`);
  }
  // ⑤ 防骗检查（没跑完 = 不通过）
  {
    const d = x.devcheck;
    if (!d || d.error || !d.verdict || !Array.isArray(d.block)) add(5, '防骗检查', false, '检查没跑完：' + String(d?.error || '无结果').slice(0, 100));
    else add(5, '防骗检查', d.verdict !== '拦' && !d.block.length, `${d.verdict}${d.block.length ? '（' + d.block.join('；') + '）' : ''}${d.warn?.length ? '｜提醒：' + d.warn.join('；') : ''}`);
  }
  const failed = gates.filter(g => !g.ok).map(g => g.name);
  return { pass: !failed.length, gates, failed };
}

// ---------- share-mint 交给 mint.mjs 的一次性通行证 ----------
// share-mint 五关全过后写 data/share-mint-gate.json，mint.mjs 收到 --share-mint <token> 时核对：token、项目、合约一致且没过期。
export const GATE_TTL_MS = 30 * 60_000;
export function gateValid(gate, { token, pid, contract, now = Date.now() }) {
  if (!gate || typeof gate !== 'object') return '没有 share-mint 通行证（只能由 npm run share-mint 在五关全过后签发）';
  if (typeof token !== 'string' || token.length < 16 || gate.token !== token) return '通行证不匹配';
  if (gate.pid !== pid || String(gate.contract).toLowerCase() !== String(contract).toLowerCase()) return '通行证不是这个项目 / 合约的';
  const at = Date.parse(gate.at);
  if (!Number.isFinite(at) || now - at > GATE_TTL_MS || at > now + 60_000) return '通行证已过期，重新跑 share-mint';
  if (!(gate.budgetUsd > 0)) return '通行证里的预算无效';
  return null;
}
