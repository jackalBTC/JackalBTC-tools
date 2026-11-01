// 到点自动领取（默认关：config.auto.claims.enabled）。会发交易，打开前读 docs/auto.md。
// 登记在 data/claims.json（由你或 AI 写，格式见 docs/auto.md）。时间到了：
//   1. eth_call 模拟，不通就下一轮再试（3 天都不通就放弃并通知）；
//   2. baw contract-call preview 预演：本钱包没有任何扣款（连 BNB 都不行）、没有授权 / 权限变化、没有风险提示、不要求 App 确认，
//      而且确实收到登记的代币——全部满足才 execute；有一条不满足就停下这条登记并通知，不会再试；
//   3. 领到的代币加进这个钱包的 watch.json（带成本和止盈设置），交给自动止盈（如果打开了）。
import { config, readJson, writeJson } from '../lib/config.mjs';
import { ethCall, baw, waitReceipt } from '../lib/chain.mjs';
import { listWallets, envFor, sessionOk, readWatch, writeWatch } from '../lib/wallets.mjs';
import { validateClaim, checkClaimPreview } from '../lib/auto-rules.mjs';
import { log, addNews, event, withLock, DRY } from './common.mjs';

const TP_KEYS = ['firstTp', 'ladder', 'back3', 'hold', 'sellOnce'];

export async function claimTick() {
  if (!config.auto?.claims?.enabled) return;
  const C = readJson('claims.json', []);
  if (!Array.isArray(C) || !C.length) return;
  const WS = await listWallets();
  let changed = false;
  for (const c of C) {
    if (!c || c.done || c.gaveUp || !(Date.now() >= Date.parse(c.notBefore))) continue;
    const bad = validateClaim(c);
    if (bad.length) { c.gaveUp = '登记格式不对：' + bad.join('；'); changed = true; log('CLAIM 格式不对', c.id || c.project, c.gaveUp); continue; }
    const w = c.wallet ? WS.find(x => x.id.toLowerCase() === String(c.wallet).toLowerCase()) : WS.find(x => x.main);
    if (!w) { c.gaveUp = '没有这个钱包：' + c.wallet; changed = true; continue; }
    const name = c.name || c.project;
    const sim = await ethCall({ from: w.address, to: c.to, data: c.data });
    if (sim.err) {
      c.lastTry = new Date().toISOString(); c.why = String(sim.data || sim.err).slice(0, 120); changed = true;
      if (Date.now() - Date.parse(c.notBefore) > 3 * 86400_000) { c.gaveUp = '3 天都模拟不通过'; addNews(c.project, '重要', `${name} 自动领取放弃`, `${w.label || w.id} 3 天都模拟不通过（${c.why.slice(0, 60)}），请看一下。`); }
      continue;
    }
    const r = await withLock(async () => {
      const se = await sessionOk(w); if (se) return { wait: se };
      const pv = await baw(['contract-call', 'preview', '--binanceChainId', String(config.chainId), '--from', w.address, '--to', c.to, '--value', '0', '--inputData', c.data], envFor(w));
      if (!pv.success) return { wait: 'preview 失败：' + (pv.error?.message || '').slice(0, 100) };
      const problems = checkClaimPreview(pv.data, { me: w.address, token: c.token });
      if (problems.length) return { stop: problems.join('；') };
      if (DRY) { log('[试运行] CLAIM 预演通过，可以领', name, w.id); return { dry: true }; }
      const se2 = await sessionOk(w); if (se2) return { wait: se2 };
      const ex = await baw(['contract-call', 'execute', '--requestId', pv.data.requestId], envFor(w));
      const tx = ex.data?.txHash;
      if (!ex.success || !tx) return { wait: '执行失败：' + String(ex.error?.message || JSON.stringify(ex.data || {})).slice(0, 100) };
      return { tx };
    });
    if (!r || r.dry) continue;
    if (r.wait) { c.why = r.wait; c.lastTry = new Date().toISOString(); changed = true; log('CLAIM 稍后再试', name, w.id, r.wait); continue; }
    if (r.stop) {
      c.gaveUp = r.stop; changed = true;
      event(c.project, 'abort', `自动领取 ${name} 已停：预演 ${r.stop}`, { contract: c.to }, w);
      addNews(c.project, '重要', `${name} 自动领取已停`, `${w.label || w.id} 领取前预演发现：${r.stop}。没有执行，请看一下。`);
      log('CLAIM STOP', name, w.id, r.stop); continue;
    }
    c.done = new Date().toISOString(); c.tx = r.tx; changed = true;
    writeJson('claims.json', C);   // 先记下已执行，免得回执等待期间进程重启后重复领
    event(c.project, 'execute', `自动领取 ${name}：预演无扣款、无授权、无风险提示，收到 ${c.symbol || '代币'}`, { tx: r.tx, contract: c.to }, w);
    const rc = await waitReceipt(r.tx);
    event(c.project, 'confirm', `自动领取回执 status=${rc?.status || '未知'}`, { tx: r.tx, contract: c.to }, w);
    if (rc?.status === '0x1') {   // 加进持仓，交给止盈
      const W = readWatch(w); W.tokens ||= [];
      if (!W.tokens.some(t => String(t.contract).toLowerCase() === c.token.toLowerCase())) {
        W.tokens.push({ id: `${c.project}-token`.slice(0, 41), name: c.tokenName || name, symbol: c.symbol || null, contract: c.token, cost: c.cost || { BNB: 0 },
          ...Object.fromEntries(TP_KEYS.filter(k => c[k] !== undefined).map(k => [k, c[k]])) });
        writeWatch(w, W);
      }
      addNews(c.project, '重要', `${name} 已自动领取`, `${w.label || w.id} 领到了 ${c.symbol || '代币'}，已加入持仓${config.auto?.takeProfit?.enabled ? '和自动止盈' : ''}。`);
      log('CLAIMED', name, w.id, r.tx);
    } else addNews(c.project, '重要', `${name} 自动领取的交易没成功`, `${w.label || w.id} 交易 ${r.tx} 回执 ${rc?.status || '没等到'}，请看一下。`);
  }
  if (changed && !DRY) writeJson('claims.json', C);
}
