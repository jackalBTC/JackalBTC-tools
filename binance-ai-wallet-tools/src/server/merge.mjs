// 看板「全部钱包」合计：把每个钱包的结果按合约合并。纯函数，test/ 里有单元测试。
// 成本是 { 币种: 数量 }（例如 { BNB: 0.01, USDT: 3 }），按币种相加；市值有一个是 null 就用另一个。
export function addCost(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const o = { ...a };
  for (const [k, v] of Object.entries(b)) o[k] = +((o[k] || 0) + (Number(v) || 0)).toFixed(10);
  return o;
}
const addNum = (a, b) => a == null ? (b ?? null) : b == null ? a : a + b;
const key = x => `${x.kind || 'nft'}:${String(x.contract).toLowerCase()}`;

export function mergePositions(lists) {
  const by = new Map();
  for (const L of lists) for (const p of L || []) {
    const k = key(p), o = by.get(k);
    if (!o) { by.set(k, { ...p, cost: addCost(null, p.cost), heldByRarity: { ...(p.heldByRarity || {}) } }); continue; }
    o.held = (o.held || 0) + (p.held || 0); o.cost = addCost(o.cost, p.cost); o.value = addNum(o.value, p.value);
    for (const [r, n] of Object.entries(p.heldByRarity || {})) o.heldByRarity[r] = (o.heldByRarity[r] || 0) + n;
  }
  return [...by.values()];
}

// 余额：同一个代币（按合约地址）数量和价值相加；登录状态全部 CONNECTED 才算 CONNECTED，否则列出哪个钱包有问题
export function mergeOverview(all) {
  const first = all[0] || {}, by = new Map();
  for (const o of all) for (const t of o.tokens || []) {
    const k = String(t.address).toLowerCase(), x = by.get(k);
    if (!x) by.set(k, { ...t }); else { x.balance += t.balance || 0; x.value = (x.value || 0) + (t.value || 0); }
  }
  const bad = all.filter(o => o.status !== 'CONNECTED');
  const errs = all.filter(o => o.tokensError).map(o => `${o.walletId}：${o.tokensError}`);
  return { ...first, wallet: null, walletId: 'all', label: `${all.length} 个钱包`, tokens: [...by.values()],
    status: bad.length ? bad.map(o => `${o.walletId} ${o.status}`).join('；') : 'CONNECTED', tokensError: errs.length ? errs.join('；') : null, at: Date.now() };
}

// NFT：同一系列合并，同一编号只留一条（任一钱包持有就算持有）
export function mergeNfts(lists) {
  const by = new Map();
  for (const L of lists) for (const c of L || []) {
    const k = String(c.contract).toLowerCase(), o = by.get(k) || by.set(k, { ...c, items: [] }).get(k);
    for (const it of c.items || []) {
      const i = o.items.findIndex(x => x.id === it.id);
      if (i < 0) o.items.push(it); else if (it.owned && !o.items[i].owned) o.items[i] = it;
    }
  }
  return [...by.values()];
}

export function mergeOutcomes(lists) {
  const by = new Map();
  for (const L of lists) for (const x of L || []) {
    const k = String(x.contract).toLowerCase(), o = by.get(k);
    if (!o) { by.set(k, { ...x, cost: addCost(null, x.cost) }); continue; }
    o.held = addNum(o.held, x.held); o.cost = addCost(o.cost, x.cost); o.value = addNum(o.value, x.value);
  }
  return [...by.values()];
}
