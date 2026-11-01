// 卡 / NFT 自动兑换代币（默认关：config.auto.redeem.enabled）。会发交易，打开前读 docs/auto.md。
// 适用于「先铸卡，开放后烧卡换代币」的项目：项目方往往不公布兑换入口，但链上能看到别人怎么换的。
//   1. 找样板：盯持有系列的 Transfer，有人把卡转给 0x0 / 0xdead / 系列合约 / 被调用的合约，同一笔交易里收到了别的代币，
//      就把这笔调用记成样板（每个系列最多 5 种写法）。只收「不付 BNB」的样板；
//   2. 照抄：他的卡号换成我们的、他的地址换成我们的（src/lib/auto-rules.mjs 的 replayCalldata），先 eth_call；
//   3. baw 预演：本钱包只少了这几张卡，没有任何扣款、授权 / 权限变化、风险提示，不要求 App 确认，而且收到样板里的代币——才执行；
//   4. 换到的代币加进 watch.json（成本 = 这个系列的成本），交给自动止盈（如果打开了）。
// 公开版刻意不做的：先授权再兑换、付费兑换、把别的钱包的卡归集过来凑张数。需要这些的项目只会通知你，自己决定。
import { config, readJson, writeJson } from '../lib/config.mjs';
import { rpc, getLogs, ethCall, baw, waitReceipt, decodeStr, sel } from '../lib/chain.mjs';
import { listWallets, envFor, sessionOk, readWatch, writeWatch } from '../lib/wallets.mjs';
import { findRedeemSample, replayCalldata, checkRedeemPreview, SINKS } from '../lib/auto-rules.mjs';
import { ELEMENT } from '../lib/element.mjs';
import { log, addNews, event, withLock, sleep, DRY } from './common.mjs';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MAX_TX = 8, MAX_SAMPLES = 5;
const addr = t => '0x' + String(t).slice(-40).toLowerCase();
let at = 0;

export async function redeemTick() {
  const R = config.auto?.redeem;
  if (!R?.enabled || Date.now() - at < R.everyMinutes * 60_000) return;
  at = Date.now();
  const st = readJson('redeem-state.json', {}); st.recipes ||= {}; st.done ||= {}; st.blocked ||= {}; st.seen ||= {}; st.told ||= {};
  // 合约 → [{ w, c }]：每个钱包只用自己手上的卡
  const WS = await listWallets(), H = new Map();
  for (const w of WS) for (const c of readWatch(w).collections || [])
    if (!c.writtenOff && /^0x[0-9a-fA-F]{40}$/.test(c.contract || '') && (c.ids || []).length) { const k = c.contract.toLowerCase(); (H.get(k) || H.set(k, []).get(k)).push({ w, c }); }
  if (!H.size) return;

  // 1) 找样板
  const head = Number(await rpc('eth_blockNumber', []));
  const from = Math.max(st.last == null ? 0 : st.last + 1, head - R.firstBlocks);
  const addrs = [...H.keys()].filter(k => (st.recipes[k] || []).length < MAX_SAMPLES), cand = new Map();
  for (let i = 0; i < addrs.length; i += 50) {
    const ls = await getLogs({ address: addrs.slice(i, i + 50), topics: [TRANSFER] }, from, head);
    for (const l of ls) {
      if (l.topics.length !== 4 || SINKS.includes(addr(l.topics[1]))) continue;   // 只看 ERC721，铸造（从 0x0 转出）不算
      const c = l.address.toLowerCase(); (cand.get(c) || cand.set(c, new Set()).get(c)).add(l.transactionHash);
    }
  }
  st.last = head;
  for (const [c, hs] of cand) {
    let n = 0;
    for (const h of [...hs].reverse()) {
      if (n >= MAX_TX || (st.recipes[c] || []).length >= MAX_SAMPLES) break;
      if (st.seen[h]) continue; st.seen[h] = Date.now(); n++;
      const [tx, rc] = await Promise.all([rpc('eth_getTransactionByHash', [h]), rpc('eth_getTransactionReceipt', [h])]);
      const sample = findRedeemSample(tx, rc, c, { markets: [ELEMENT, ...(R.ignoreTargets || [])] });
      if (!sample) continue;
      const L = (st.recipes[c] ||= []);
      if (L.some(s => s.to === sample.to && s.input.slice(0, 10) === sample.input.slice(0, 10) && s.ids.length === sample.ids.length)) continue;   // 同一种写法
      L.push({ ...sample, at: new Date().toISOString() });
      log('REDEEM 样板', c, sample.input.slice(0, 10), '×' + sample.ids.length, '→', sample.token, h);
      if (L.length === 1) { const { c: col } = H.get(c)[0];
        addNews(col.id, '重要', `${col.name || col.id} 开放兑换了`, `链上看到有人${sample.ids.length > 1 ? `一次烧 ${sample.ids.length} 张` : '烧卡'}换到了代币（${sample.token}，样板交易 ${h}）。正在按同样的写法给持有这个系列的钱包兑换。`); }
    }
  }
  for (const [h, t] of Object.entries(st.seen)) if (Date.now() - t > 7 * 86400_000) delete st.seen[h];

  // 2) 照抄兑换：每个钱包只用自己的卡；一个样板不行就换下一个，全都不行才通知
  for (const [c, samples] of Object.entries(st.recipes)) {
    const holders = H.get(c) || [], fails = new Map();
    for (const [si, r] of samples.entries()) {
      const k = r.ids.length;
      for (const { w, c: col } of holders) {
        const bk = `${w.id}:${c}`;
        if ((st.blocked[bk]?.tried ?? 0) > si) continue;   // 这个样板对这个钱包试过不行
        const myIds = (col.ids || []).map(String).filter(id => !st.done[`${bk}:${id}`]);
        if (!myIds.length) continue;
        if (myIds.length < k) { st.blocked[bk] = { why: `要 ${k} 张一起换，这个钱包只有 ${myIds.length} 张（公开版不在钱包之间归集）`, tried: si + 1 }; fails.set(w.id, `${w.label || w.id}：${st.blocked[bk].why}`); continue; }
        let n = 0, why = null; const got = [];
        for (let i = 0; i + k <= myIds.length && !why; i += k) {
          const grp = myIds.slice(i, i + k), data = replayCalldata(r, grp, w.address);
          if (!data) { why = '样板的调用数据看不懂（卡号和别的参数撞在一起），不冒险照抄'; break; }
          const sim = await ethCall({ from: w.address, to: r.to, data });
          if (sim.err) { why = `照抄样板模拟不通过（${String(sim.err).slice(0, 60)}；可能要先授权，公开版不做授权）`; break; }
          const res = await withLock(async () => {
            const se = await sessionOk(w); if (se) return { wait: se };
            const pv = await baw(['contract-call', 'preview', '--binanceChainId', String(config.chainId), '--from', w.address, '--to', r.to, '--value', '0', '--inputData', data], envFor(w));
            if (!pv.success) return { wait: 'preview 失败：' + String(pv.error?.message || '').slice(0, 80) };
            const problems = checkRedeemPreview(pv.data, { me: w.address, nft: c, token: r.token, cards: k });
            if (problems.length) return { stop: problems.join('；') };
            if (DRY) { log('[试运行] REDEEM 预演通过，可以兑换', col.name, w.id, grp.join('+')); return { dry: true }; }
            const se2 = await sessionOk(w); if (se2) return { wait: se2 };
            const ex = await baw(['contract-call', 'execute', '--requestId', pv.data.requestId], envFor(w));
            return ex.success && ex.data?.txHash ? { tx: ex.data.txHash } : { wait: '执行失败：' + String(ex.error?.message || '').slice(0, 80) };
          });
          if (!res || res.dry || res.wait) { if (res?.wait) log('REDEEM 稍后再试', col.name, w.id, res.wait); break; }
          if (res.stop) { why = '预演不通过：' + res.stop; break; }
          for (const g of grp) st.done[`${bk}:${g}`] = res.tx;
          if (!DRY) writeJson('redeem-state.json', st);   // 先记下，免得重启后重复发
          event(col.id, 'execute', `自动兑换：交出 #${grp.join(' #')} 换 ${r.token}（照抄样板 ${r.tx}；预演只交卡、无扣款、无授权变化）`, { tx: res.tx, contract: r.to }, w);
          const rc = await waitReceipt(res.tx);
          event(col.id, 'confirm', `自动兑换回执 status=${rc?.status || '未知'}`, { tx: res.tx, contract: r.to }, w);
          if (rc?.status === '0x1') { n += k; got.push(...grp); } else { why = `兑换交易 ${res.tx} 没成功`; for (const g of grp) delete st.done[`${bk}:${g}`]; }
          await sleep(3000);
        }
        if (why) { st.blocked[bk] = { why, tried: si + 1 }; fails.set(w.id, `${w.label || w.id}：${why}`); }
        else if (n) { delete st.blocked[bk]; fails.delete(w.id); }
        if (!n) continue;
        // 换到的代币进持仓；换掉的卡从持仓里去掉
        const sym = decodeStr(await rpc('eth_call', [{ to: r.token, data: '0x' + sel('symbol()') }, 'latest']).catch(() => '0x')).replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 16) || 'TOKEN';
        const W = readWatch(w); W.tokens ||= [];
        const cc = (W.collections || []).find(q => String(q.contract).toLowerCase() === c);
        if (cc) cc.ids = (cc.ids || []).filter(id => !got.includes(String(id)));
        if (!W.tokens.some(t => String(t.contract).toLowerCase() === r.token)) W.tokens.push({ id: `${col.id}-token`.slice(0, 41), name: `${col.name || col.id} 兑换的代币`, symbol: sym, contract: r.token, cost: col.cost || { BNB: 0 }, from: 'redeem' });
        if (!DRY) writeWatch(w, W);
        addNews(col.id, '重要', `${col.name || col.id} 已自动兑换`, `${w.label || w.id} 交出 ${n} 张，换到 ${sym}，已加入持仓${config.auto?.takeProfit?.enabled ? '和自动止盈' : ''}。`);
        log('REDEEMED', col.name, w.id, got.join('+'));
      }
    }
    const list = [...fails.values()], key = c + ':' + list.join('|');
    if (list.length && !st.told[key] && (st.recipes[c] || []).length) {
      st.told[key] = Date.now(); const col = holders[0]?.c || {};
      addNews(col.id || 'redeem', '重要', `${col.name || c} 有钱包没自动换成`, `已经试过 ${samples.length} 种样板写法（只做零授权、零付费、钱包自己的卡）。没换成的：\n${list.join('\n')}\n要不要手动处理，在 AI 对话里说；出现新样板会自动再试。`);
    }
  }
  if (!DRY) writeJson('redeem-state.json', st);
}
