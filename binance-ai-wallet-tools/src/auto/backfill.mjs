// 掉线补领（默认关：config.auto.backfill.enabled）。会发交易，打开前读 docs/auto.md。
// 后台每隔几分钟看一次每个钱包登录了没有；某个钱包从「掉线」变回「在线」时，把掉线期间别的钱包领过的免费项目给它补一遍。
// 也可以手动跑：npm run backfill -- <钱包id> [起始时间]（src/cli/backfill.mjs）。
// 每一笔都和自动领取一样把关（src/lib/missed.mjs）：样板交易成功且不付 BNB → 把调用数据里那个钱包的地址换成这个钱包 →
//   value = 0 模拟通过 → baw 预演：零扣款（连 BNB 都不行）、零授权 / 权限变化、零风险提示、不要求 App 确认、确实收到东西 → 才执行。
// 结果记在 data/backfill-state.json（每个钱包每个项目一条）；网络读不到的不记，下次再试。花费账 spend.jsonl 记 bnb = 0。
import fs from 'node:fs';
import { config, readJson, writeJson, dataFile } from '../lib/config.mjs';
import { rpc, ethCall, baw, waitReceipt, nftIdsReceived } from '../lib/chain.mjs';
import { listWallets, envFor, sessionOk, readWatch, writeWatch, multiWallet } from '../lib/wallets.mjs';
import { missedCandidates, swapAddress, sampleUsable, checkReplayPreview, loginTransition } from '../lib/missed.mjs';
import { log, addNews, event, withLock, DRY, sleep } from './common.mjs';

const spends = () => { try { return fs.readFileSync(dataFile('spend.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

// 排队：两个钱包同时回来时一个接一个补
let QUEUE = Promise.resolve();
export function backfillWallet(w, since, opt = {}) {
  const r = QUEUE.then(() => inner(w, since, opt));
  QUEUE = r.catch(() => {});
  return r;
}

async function inner(w, since, { max = 50 } = {}) {
  const WS = await listWallets();
  const S = readJson('backfill-state.json', {}), done = (S[w.id] ||= {});
  const cand = missedCandidates(spends(), { wallets: WS, id: w.id, since, done }).slice(0, max);
  log('BACKFILL 开始', w.id, '自', new Date(since).toISOString().slice(0, 16), '候选', cand.length);
  let ok = 0, skip = 0, fail = 0;
  for (const c of cand) {
    const [tx, rc] = await Promise.all([rpc('eth_getTransactionByHash', [c.tx]).catch(() => null), rpc('eth_getTransactionReceipt', [c.tx]).catch(() => null)]);
    if (!tx || !rc) { skip++; continue; }   // 网络没读到：不记，下次再试
    const bad = sampleUsable(tx, rc) || (String(tx.from).toLowerCase() !== c.from ? '样板不是那个钱包发的' : null);
    if (bad) { done[c.pid] = 'skip:' + bad; skip++; continue; }
    const data = swapAddress(tx.input, c.from, w.address);
    if (!data) { done[c.pid] = 'skip:调用数据格式看不懂'; skip++; continue; }
    const sim = await ethCall({ from: w.address, to: tx.to, data });
    const net = sim.err && sim.data == null && /fetch failed|timeout|aborted|RPC 暂时不可用|ECONN|ENOTFOUND|socket/i.test(sim.err);   // 网络问题不算「领不了」
    if (sim.err) { if (!net) done[c.pid] ='skip:模拟不通过 ' + String(sim.data || sim.err).slice(0, 60); skip++; continue; }
    if (DRY) { log('[试运行] BACKFILL 模拟通过，可以补', w.id, c.pid); continue; }
    const r = await withLock(async () => {
      const se = await sessionOk(w); if (se) return { offline: se };
      const pv = await baw(['contract-call', 'preview', '--binanceChainId', String(config.chainId), '--from', w.address, '--to', tx.to, '--value', '0', '--inputData', data], envFor(w));
      if (!pv.success) return { wait: 'preview 失败：' + String(pv.error?.message || '').slice(0, 100) };
      const problems = checkReplayPreview(pv.data, { me: w.address });
      if (problems.length) return { stop: problems.join('；') };
      const se2 = await sessionOk(w); if (se2) return { offline: se2 };
      const ex = await baw(['contract-call', 'execute', '--requestId', pv.data.requestId], envFor(w));
      const h = ex.data?.txHash;
      if (!ex.success || !h) return { wait: '执行失败：' + String(ex.error?.message || JSON.stringify(ex.data || {})).slice(0, 100) };
      return { tx: h };
    });
    if (!r) { skip++; continue; }   // 有 mint 在跑，下次再试
    if (r.offline) { log('BACKFILL 停：钱包又掉线了', w.id, r.offline); break; }
    if (r.wait) { skip++; log('BACKFILL 稍后再试', w.id, c.pid, r.wait); continue; }
    if (r.stop) { done[c.pid] = 'skip:预演 ' + r.stop.slice(0, 80); skip++; log('BACKFILL 预演不通过', w.id, c.pid, r.stop); writeJson('backfill-state.json', S); continue; }
    done[c.pid] = r.tx; writeJson('backfill-state.json', S);   // 先记下，免得等回执期间重启后重复领
    try { fs.appendFileSync(dataFile('spend.jsonl'), JSON.stringify({ ts: new Date().toISOString(), pid: c.pid, contract: tx.to, paid: 0, bnb: 0, tx: r.tx, backfill: true, ...(multiWallet() ? { wallet: w.id } : {}) }) + '\n'); } catch (e) { log('ERR 花费账写入失败', e.message); }
    event(c.pid, 'execute', `掉线补领：照 ${c.tx.slice(0, 10)}… 的免费领取，预演零扣款、零授权、零风险提示`, { tx: r.tx, contract: tx.to }, w);
    const rc2 = await waitReceipt(r.tx);
    const ids = rc2 ? nftIdsReceived(rc2, tx.to, w.address) : [];
    event(c.pid, 'confirm', `补领回执 status=${rc2?.status || '未知'}，到手 #${ids.join(',') || '-'}`, { tx: r.tx, contract: tx.to }, w);
    if (rc2?.status === '0x1') {
      ok++;
      if (ids.length) {   // 记进持仓，和 mint 一样
        const W = readWatch(w); W.collections ||= [];
        let col = W.collections.find(x => String(x.contract).toLowerCase() === String(tx.to).toLowerCase());
        if (!col) { const p = (readJson('projects.json', []) || []).find(x => x.id === c.pid) || {}; col = { id: c.pid, name: p.name || c.pid, contract: tx.to, ids: [], image: 'tokenURI', market: { type: 'none' }, cost: { BNB: 0 } }; W.collections.push(col); }
        col.ids = [...new Set([...(col.ids || []), ...ids])].sort((a, b) => a - b);
        writeWatch(w, W);
      }
      log('BACKFILLED', w.id, c.pid, r.tx);
    } else { fail++; log('BACKFILL 交易没成功', w.id, c.pid, r.tx, rc2?.status || '没等到回执'); }
    await sleep(1500);
  }
  if (!DRY) writeJson('backfill-state.json', S);
  log('BACKFILL 结束', w.id, `补到 ${ok}，跳过 ${skip}，失败 ${fail}`);
  if (ok && !DRY) addNews('backfill', '一般', `${w.label || w.id} 补领了 ${ok} 个免费项目`, `这个钱包掉线期间别的钱包领过的免费项目，补到 ${ok} 个（跳过 ${skip}，失败 ${fail}）。`);
  return { ok, skip, fail, cand: cand.length };
}

// 后台：看登录状态，掉线 → 在线时补领
let at = 0;
export async function backfillTick() {
  const B = config.auto?.backfill;
  if (!B?.enabled || Date.now() - at < (B.everyMinutes || 5) * 60_000) return;
  at = Date.now();
  const WS = await listWallets();
  if (WS.length < 2) return;   // 只有一个钱包没有可照抄的
  const st = readJson('login-state.json', {});
  for (const w of WS) {
    const s = await baw(['wallet', 'status'], envFor(w)).catch(() => null);
    if (!s) continue;   // 读不到不算掉线
    const up = s?.data?.status === 'CONNECTED';
    const { next, backfillFrom } = loginTransition(st[w.id], up);
    st[w.id] = next;
    if (backfillFrom != null) {
      const from = Math.max(backfillFrom, Date.now() - (B.maxLookbackHours || 72) * 3600_000);
      log('LOGIN 钱包重新在线，开始补领', w.id);
      backfillWallet(w, from, { max: B.maxPerRun || 50 }).catch(e => log('ERR backfill', w.id, e.message));
    }
  }
  if (!DRY) writeJson('login-state.json', st);
}
