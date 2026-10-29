// 花钱规则与预演检查：不碰网络的纯逻辑，mint.mjs 调用，test/ 里有单元测试。
// 改这里的任何行为，都要同步改测试和 docs/security.md。

const nonEmpty = v => Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : !!v;
const KNOWN_TYPES = ['native', 'erc20', 'erc721', 'erc1155'];

// 检查 baw contract-call preview 的结果。返回问题列表，空数组才算通过。
// 规则：缺字段或看不懂的格式一律不通过；本钱包除了付给本合约、且不超过 total（wei）的原生币外，不能有任何负向变化；
// 不能有授权 / 权限变化、任何风险提示（含风险地址）、预检码异常、需要二次确认；必须有 requestId。
export function checkPreview(data, { me, total }) {
  const x = data || {}, s = x.simulationResult, problems = [];
  const owner = String(me).toLowerCase(), max = BigInt(total);
  if (!s || typeof s !== 'object') problems.push('预演结果缺少 simulationResult');
  else {
    if (s.simulationCode !== '000000000') problems.push('模拟码异常 ' + s.simulationCode);
    if (s.preCheckCode != null && !['', '000000000'].includes(String(s.preCheckCode))) problems.push('预检码异常 ' + s.preCheckCode);
    if (!Array.isArray(s.balanceChanges)) problems.push('预演结果缺少 balanceChanges');
    for (const b of s.balanceChanges || []) {
      const type = String(b?.tokenType || '').toLowerCase(), ch = Number(b?.change);
      if (typeof b?.owner !== 'string' || !Number.isFinite(ch) || !KNOWN_TYPES.includes(type)) { problems.push('看不懂的余额变化 ' + JSON.stringify(b).slice(0, 100)); continue; }
      if (b.owner.toLowerCase() !== owner || ch >= 0) continue;
      if (!(type === 'native' && -ch <= Number(max))) problems.push('额外扣款 ' + JSON.stringify(b).slice(0, 120));
    }
    if (nonEmpty(s.allowanceChanges)) problems.push('有授权变化');
    if (nonEmpty(s.authorityChanges)) problems.push('有权限变化');
  }
  const r = x.risks;
  if (!r || typeof r !== 'object') problems.push('预演结果缺少 risks');
  else if (nonEmpty(r.riskDetails) || nonEmpty(r.riskBehaviors) || nonEmpty(r.addresses)) problems.push('有风险提示（含风险地址）');
  if (x.requireConfirmation) problems.push('需要二次确认');
  if (!x.requestId) problems.push('没有 requestId');
  return problems;
}

// 按花钱规则决定付费几张。
//   free / paid：免费张数、想付费的张数；totalOf(q)：q 张一共要付多少 wei（async，可能返回 null）
//   ctx：{ spending, usdPerBnb, verified, official, freeOnly, clone, spentToday, paidSoFar }
// 返回 { paid, total, notes }：不能付的直接归零（单价超、没开自动付费、未验证、无官源、模板克隆），
// 张数 / 每日金额超了就一张张往下减。
export async function planPaid({ free, paid, totalOf }, ctx) {
  const S = ctx.spending, notes = [];
  if (paid <= 0) return { paid: 0, total: 0n, notes };
  let total = await totalOf(free + paid);
  if (total === null) return { paid: 0, total: 0n, notes: ['读不到报价'] };
  const bnb = t => Number(t) / 1e18;
  const unitUsd = ctx.usdPerBnb ? bnb(total) / paid * ctx.usdPerBnb : Infinity;
  const hard = [];
  if (ctx.freeOnly) hard.push('指定了只拿免费');
  if (S.allowAutoPaid !== true) hard.push('配置里未开启自动付费（spending.allowAutoPaid）');
  if (!ctx.verified) hard.push('源码未验证');
  if (!ctx.official) hard.push('台账里没有官网 / 官推');
  if (ctx.clone) hard.push(`疑似批量模板项目（${ctx.clone}）`);
  if (bnb(total) > S.gasLikeBnb && unitUsd > S.maxUnitUsd) hard.push(`单张约 $${unitUsd.toFixed(2)} 超过 $${S.maxUnitUsd}`);
  if (hard.length) return { paid: 0, total: 0n, notes: hard };
  const want = paid;
  while (paid > 0) {
    const gasLike = bnb(total) <= S.gasLikeBnb;
    const overCount = !gasLike && ctx.paidSoFar + paid > S.maxPaidPerProject;
    const overDaily = ctx.spentToday + bnb(total) > S.maxDailyBnb;
    if (!overCount && !overDaily) break;
    paid--;
    total = paid ? await totalOf(free + paid) : 0n;
    if (total === null) return { paid: 0, total: 0n, notes: ['读不到报价'] };
  }
  if (paid < want) notes.push(`付费从 ${want} 张减到 ${paid} 张（这个合约已付 ${ctx.paidSoFar} 张，上限 ${S.maxPaidPerProject}；今天已付 ${ctx.spentToday.toFixed(5)} BNB，上限 ${S.maxDailyBnb}）`);
  return { paid, total, notes };
}

// 从合约 ABI 里找报价函数：要求是只读函数、参数里有数量（uint256）、返回值里有名字像「费用 / 价格 / wei」的 uint。
// 返回 { sig, args: ['wallet'|'qty'|'agentId', …], out } 或 null。找不到时 mint.mjs 会退回常见函数名的猜测，并且都要用模拟交易复核。
export function pickQuoteFromAbi(abi) {
  if (!Array.isArray(abi)) return null;
  const NAME = /^(quote|quoteMint|quoteFor|getQuote|mintCost|priceFor|costFor|getMintPrice|quoteBnb|quoteBnbFor|totalCost|getCost)$/i;
  const OUT = /wei|cost|price|value|total|amount|fee/i;
  const cands = [];
  for (const f of abi) {
    if (f?.type !== 'function' || !['view', 'pure'].includes(f.stateMutability) || !NAME.test(f.name || '')) continue;
    const types = (f.inputs || []).map(i => i.type);
    const args = types.map((t, i) => {
      const n = f.inputs[i].name || '';
      if (t === 'address') return 'wallet';
      if (t === 'uint256' && /agent/i.test(n)) return 'agentId';
      if (t === 'uint256' && (!n || /qty|quantity|amount|count|num|^n$/i.test(n))) return 'qty';
      return null;
    });
    if (args.includes(null) || !args.includes('qty')) continue;
    const outs = f.outputs || [];
    let out = outs.findIndex(o => /^uint/.test(o.type) && /wei/i.test(o.name || ''));
    if (out < 0) out = outs.findIndex(o => /^uint/.test(o.type) && OUT.test(o.name || ''));
    if (out < 0 && outs.length === 1 && /^uint/.test(outs[0].type)) out = 0;
    if (out < 0) continue;
    cands.push({ sig: `${f.name}(${types.join(',')})`, args, out, score: /wei/i.test(outs[out].name || '') ? 2 : 1 });
  }
  cands.sort((a, b) => b.score - a.score);
  return cands[0] ? { sig: cands[0].sig, args: cands[0].args, out: cands[0].out } : null;
}
