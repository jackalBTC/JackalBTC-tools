// 授权巡检的纯逻辑（不联网）：src/auto/approvals.mjs 调用，test/ 里有单元测试。
// 只提醒，不撤销：撤销要你自己在币安 App 里做（或跟 AI 说「撤销授权」，它会先给你看再执行）。

const UNLIMITED = 2n ** 200n;
const clean = (v, n = 42) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f<>`*_[\]]+/g, ' ').trim().slice(0, n);

// 一条授权的唯一键：有 id 用 id，没有就用「代币 + 授权对象 + 类型」
export const approvalKey = a => a?.id != null && a.id !== '' ? String(a.id)
  : `${String(a?.tokenContract || '').toLowerCase()}:${String(a?.spender || '').toLowerCase()}:${String(a?.type || a?.approvalType || '')}`;
// 无限额：写着 unlimited，或数额 ≥ 2^200
export function isUnlimited(amount) {
  if (String(amount).trim().toLowerCase() === 'unlimited') return true;
  try { return BigInt(String(amount).trim()) >= UNLIMITED; } catch { return false; }
}
export const isRisky = a => Number(a?.riskyLevel) > 0 || a?.noInteractive === true;

// prev：上次记下的键（数组；undefined = 第一次）；list：这次 baw approvals list 的结果
// → { first: 是否第一次（只记底不提醒）, fresh: 新出现的授权, keys: 这次的键（存起来） }
export function diffApprovals(prev, list) {
  const L = Array.isArray(list) ? list : [];
  const keys = [...new Set(L.map(approvalKey))];
  if (!Array.isArray(prev)) return { first: true, fresh: [], keys };
  const seen = new Set(prev);
  return { first: false, fresh: L.filter(a => !seen.has(approvalKey(a))), keys };
}

// 一条新授权 → 项目动态 { level, title, summary }。无限额或币安标了风险 → 「重要」（响铃），其余「注意」
export function approvalNews(a, walletName) {
  const unlimited = isUnlimited(a?.amount), risky = isRisky(a);
  const sym = clean(a?.tokenSymbol, 20) || clean(a?.tokenContract);
  const who = a?.spenderName ? `${clean(a.spenderName, 40)}（${clean(a.spender)}）` : clean(a?.spender);
  return {
    level: unlimited || risky ? '重要' : '注意',
    title: `${clean(walletName, 40)} 新增授权：${sym}`,
    summary: `${clean(a?.tokenSymbol, 20)} ${clean(a?.tokenContract)} 授权给 ${who}，额度 ${unlimited ? '无限' : clean(a?.amount, 40)}${risky ? '，币安标了风险' : ''}。`
      + '不是你或程序有意做的，就去币安 App 里撤销（或跟 AI 说「撤销授权」）。工具不会自动撤销。',
  };
}
