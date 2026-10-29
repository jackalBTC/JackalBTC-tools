#!/usr/bin/env node
// 推特雷达：定时搜 X，粗筛出带官网 / 合约的新线索，写 data/radar-candidates.jsonl，并在日志里打一行（给 Claude Code 的 Monitor 读）。
// 只读：不执行推文里的任何内容，不访问推文里的链接，只提取文字、网址、0x 地址。
// 数据源在 config.radar.provider 里选：twitterapi（twitterapi.io）或 grok（xAI x_search）。
// 用法: node src/radar/radar.mjs [--once]
// 日志行的开头：CANDIDATE 新线索 / HOT 多人在传 / UPDATE 已参与项目的官推新帖 / ROUND 每轮汇总 / ERR 出错（含 ERR LOWBNB 余额不足）
import fs from 'node:fs';
import { config, dataFile, readJson, writeJson, DATA } from '../lib/config.mjs';
import { rpc, baw } from '../lib/chain.mjs';
import { readWallets, listWallets, envFor, sessionOk } from '../lib/wallets.mjs';
import { sameCodeAs } from '../lib/clones.mjs';
import * as twitterapi from './providers/twitterapi.mjs';
import * as grok from './providers/grok.mjs';
import { dispatch } from './agent.mjs';

const R = config.radar;
const P = { twitterapi, grok }[R.provider];   // 配置校验已保证只会是这两个之一
// 日志一行一条：外部来的字段去掉换行和控制字符，防止伪造出假的 CANDIDATE 行
const clean = v => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ');
const log = (...a) => console.log(new Date().toLocaleString('zh-CN', { hour12: false }), ...a.map(clean));
fs.mkdirSync(DATA, { recursive: true });
if (!P.ready()) {   // 没有 Key 时不退出（避免后台服务每 30 秒重启一次），每 10 分钟检查一次
  log('ERR', `数据源 ${R.provider} 没有配置 Key，先运行 npm run setup。配好后会自动开始。`);
  if (process.argv.includes('--once')) process.exit(1);
  await new Promise(res => { const t = setInterval(() => { if (P.ready()) { clearInterval(t); res(); } }, 10 * 60_000); });
}

function append(obj) {
  const f = dataFile('radar-candidates.jsonl');
  try { if (fs.statSync(f).size > 5 << 20) fs.renameSync(f, f + '.1'); } catch {}   // 超过 5MB 轮转一次
  fs.appendFileSync(f, JSON.stringify(obj) + '\n');
}
// 已参与项目的官推：config.radar.watchAccounts（用户自己填）+ data/watch-accounts.json（Claude 打完项目后追加）
const watchAccounts = () => [...new Set([...(R.watchAccounts || []), ...readJson('watch-accounts.json', [])]
  .map(a => String(a).replace(/^@/, '').trim()).filter(a => /^[A-Za-z0-9_]{1,15}$/.test(a)))];
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
const matchDomain = (host, list) => list.some(d => host === d || host.endsWith('.' + d));

function extract(t) {
  const urls = new Set(), cas = new Set();
  const addCa = s => { for (const m of String(s).matchAll(/0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g)) cas.add(m[0].toLowerCase()); };
  const addUrl = u => { addCa(u); const h = hostOf(u); if (h && !matchDomain(h, R.ignoreDomains)) urls.add(h); };
  addCa(t.text);
  for (const e of t.entities?.urls || []) addUrl(e.expanded_url || e.url || '');
  for (const m of String(t.text).matchAll(/https?:\/\/[^\s)"'<>]+/g)) addUrl(m[0]);
  for (const c of R.ignoreCas || []) cas.delete(c.toLowerCase());
  return { domains: [...urls], cas: [...cas] };
}

function score(t, ex) {
  const s = t.text.toLowerCase(); let v = 0; const why = [];
  if (/agent ?id|agentic wallet|ai钱包|\.ai\b/.test(s)) { v += 3; why.push('Agent ID'); }
  if (/free|免费|0 ?bnb|0撸/.test(s)) { v += 2; why.push('免费'); }
  if (/mint|claim|铸造|领取|打新/.test(s)) { v += 1; why.push('参与动作'); }
  if (/skill\.md|llms\.txt|paste to your agent|复制提示词|agent-only/.test(s)) { v += 2; why.push('Agent 入口'); }
  if (ex.cas.length) { v += 2; why.push('有合约'); }
  if (/presale|预售|giveaway|抽奖|drop your wallet|tag 3/.test(s)) { v -= 4; why.push('拉人头 / 预售'); }
  if (/#myagentid|my agent id( is|:)|我的 ?agent ?id|i'm agent #/.test(s)) { v -= 6; why.push('晒身份的活动帖'); }
  if (/i'm joining the @\w+ whitelist|\bcode: ?[a-z]{2,4}-[a-z0-9]{4,}|邀请码[:：]/.test(s)) { v -= 6; why.push('邀请码刷单帖'); }
  const f = t.author?.followers ?? 0; if (f >= 1000) { v += 1; why.push('粉丝≥1k'); }
  return { v, why };
}

// 台账 / 持仓里已有的合约和官网：再次出现不提醒
function known() {
  const ca = new Set(), site = new Set();
  for (const p of readJson('projects.json', [])) {
    if (['观察中', '待确认'].includes(p.status)) continue;   // 还在等开放 / 等用户决定的项目，再出现要照常提醒
    for (const v of Object.values(p.contracts || {})) if (/^0x[0-9a-fA-F]{40}$/.test(v)) ca.add(v.toLowerCase());
    const h = p.site && hostOf(p.site); if (h) site.add(h);
  }
  for (const c of readJson('watch.json', { collections: [] }).collections || []) if (c.contract) ca.add(c.contract.toLowerCase());
  return { ca, site };
}

// 每轮顺便检查钱包：掉线、开发者模式关闭或快到期、BNB 不足。掉线时 mint 会失败，必须让人知道。
async function checkWallet(st) {
  try {
    const main = (await listWallets()).find(w => w.main), env = envFor(main);
    const s = await baw(['wallet', 'status'], env);
    if (s?.data?.status !== 'CONNECTED') { log('ERR NOTCONNECTED', `AI 钱包未登录（${s?.data?.status || s?.error?.message || '未知'}），运行 baw auth signin 扫码`); return; }
    const dm = (await baw(['wallet', 'settings'], env))?.data?.devMode;
    if (dm && !dm.enabled) log('ERR DEVMODE', '开发者模式已关闭，合约调用会失败：币安 App → AI 钱包 → 设置 → 开发者模式');
    else if (dm?.expiresAt) {
      const left = (Date.parse(dm.expiresAt) - Date.now()) / 3600_000;
      if (left < 48 && (!st.devWarnAt || Date.now() - st.devWarnAt > 6 * 3600_000)) { log('ERR DEVMODE', `开发者模式 ${left < 0 ? '已经' : '将在 ' + left.toFixed(0) + ' 小时后'}到期（${dm.expiresAt}），到期后请在 App 里重新打开`); st.devWarnAt = Date.now(); }
    }
    const bnb = Number(BigInt(await rpc('eth_getBalance', [main.address, 'latest']))) / 1e18;
    if (bnb < config.alerts.lowBnb) log('ERR LOWBNB', `钱包 BNB 只剩 ${bnb.toFixed(4)}，低于提醒线 ${config.alerts.lowBnb}`);
  } catch {}
}

// 副钱包（data/wallets.json）：同样检查掉线 / 会话被顶掉、开发者模式、BNB 不足。同一钱包同一类问题 2 小时内只报一次，免得刷屏
async function checkOtherWallets(st) {
  st.walletWarn ||= {};
  const warn = (id, kind, msg) => { const k = `${id}|${kind}`; if (Date.now() - (st.walletWarn[k] || 0) < 2 * 3600_000) return; st.walletWarn[k] = Date.now(); log(kind === 'ERR' ? 'ERR' : 'ERR ' + kind, `[${id}] ${msg}`); };
  let L;
  try { L = readWallets().filter(w => !w.main); } catch (e) { warn('wallets', 'ERR', e.message.replace(/\n\s*/g, ' ')); return; }
  for (const w of L) {
    try {
      const env = envFor(w), e = await sessionOk(w);
      if (e) { warn(w.id, 'NOTCONNECTED', `${e}。运行 npm run wallet login ${w.id} 重新扫码`); continue; }
      const dm = (await baw(['wallet', 'settings'], env))?.data?.devMode;
      if (dm && !dm.enabled) warn(w.id, 'DEVMODE', '开发者模式已关闭，这个钱包的合约调用会失败');
      else if (dm?.expiresAt) {
        const left = (Date.parse(dm.expiresAt) - Date.now()) / 3600_000;
        if (left < 48) warn(w.id, 'DEVMODE', `开发者模式${left < 0 ? '已经' : '将在 ' + left.toFixed(0) + ' 小时后'}到期（${dm.expiresAt}）`);
      }
      const bnb = Number(BigInt(await rpc('eth_getBalance', [w.address, 'latest']))) / 1e18;
      if (bnb < config.alerts.lowBnb) warn(w.id, 'LOWBNB', `BNB 只剩 ${bnb.toFixed(4)}，低于提醒线 ${config.alerts.lowBnb}`);
    } catch {}
  }
  for (const [k, t] of Object.entries(st.walletWarn)) if (Date.now() - t > 7 * 86400_000) delete st.walletWarn[k];
}

async function cycle() {
  const st = readJson('radar-state.json', { lastChecked: {}, seenTweets: [], keys: {}, cost: { provider: R.provider, requests: 0, tweets: 0, usd: 0 } });
  const seen = new Set(st.seenTweets);
  const now = Math.floor(Date.now() / 1000);
  const kn = known();
  const firstRun = !st.lastRun;   // 第一次运行会扫到过去几小时的存量线索，只记录、不交给 AI，避免一上来就批量处理
  await checkWallet(st);
  await checkOtherWallets(st);
  let found = 0, req = 0, got = 0;

  const jobs = R.queries.map(q => ({ ...q, alwaysReport: false }));
  const accounts = watchAccounts();
  const chunk = Math.max(1, Math.min(R.watchChunk || 8, 10));   // 官推分组查询，避免一条查询太长
  for (let i = 0; i < accounts.length; i += chunk) jobs.push({ id: 'watch-' + (i / chunk + 1), handles: accounts.slice(i, i + chunk), alwaysReport: true });

  for (const qd of jobs) {
    const since = Math.max((st.lastChecked[qd.id] || now - 3600) - R.overlapMinutes * 60, now - 6 * 3600);
    let cursor = '', ok = true, truncated = false;
    const pages = R.provider === 'grok' ? 1 : (qd.pages || R.pagesPerQuery);   // 每条查询可单独设 pages
    for (let p = 0; p < pages; p++) {
      let j;
      try { j = await P.search({ query: qd.q, handles: qd.handles, sinceUnix: since, cursor }); }
      catch (e) { log('ERR', qd.id, e.message); ok = false; break; }
      req++; got += j.tweets.length; st.cost.tweets += j.tweets.length;
      if (R.provider === 'grok' && j.tweets.length >= 40) log('ERR', qd.id, 'Grok 单次最多整理 40 条，可能有遗漏；可缩短 intervalMinutes');
      if (R.provider === 'twitterapi') st.cost.usd = +((st.cost.usd || 0) + j.billed * twitterapi.PRICE_PER_TWEET).toFixed(5);
      for (const t of j.tweets) {
        if (!t.id || seen.has(t.id)) continue;
        seen.add(t.id);
        if (qd.alwaysReport) {   // 已参与项目的官推：@别人 开头的回复不算动态
          if (/^\s*@/.test(t.text)) continue;
          const ex = extract(t);
          append({ ts: new Date().toISOString(), kind: 'update', key: 'tweet:' + t.id, query: qd.id, tweet: t.url, author: t.author?.userName,
            followers: t.author?.followers, createdAt: t.createdAt, text: t.text.slice(0, 500), ...ex });
          log('UPDATE', `@${t.author?.userName}`, t.url, t.text.slice(0, 80).replace(/\n/g, ' '));
          if (!firstRun) dispatch({ kind: 'update', key: 'tweet:' + t.id, tweet: t.url }, log);
          found++; continue;
        }
        const ex = extract(t);
        if (ex.cas.length > (R.maxCasPerTweet ?? 3)) continue;          // 一帖列一堆合约的清单 / 二手帖：丢弃
        const hadKnown = ex.cas.some(c => kn.ca.has(c));
        ex.cas = ex.cas.filter(c => !kn.ca.has(c));
        if (hadKnown && !ex.cas.length) continue;   // 合约都是已参与项目的：晒单 / 推广帖，附带的个人页域名也不算新线索
        ex.domains = ex.domains.filter(d => !kn.site.has(d));
        if (!ex.domains.length && !ex.cas.length) continue;
        const sc = score(t, ex);
        // 和已知项目对外函数完全相同的合约：批量模板，降分并标注
        for (const ca of ex.cas.slice(0, 2)) {
          const twins = await sameCodeAs(ca).catch(() => []);
          if (twins.length) { sc.v -= 3; sc.why.push(`批量模板（与 ${twins.length} 个已知合约相同）`); break; }
        }
        if (sc.v < 3) continue;
        for (const key of [...ex.cas.map(c => 'ca:' + c), ...ex.domains.map(d => 'site:' + d)]) {
          const k = st.keys[key] ||= { first: now, authors: [], tweets: [], hot: false };
          const a = t.author?.userName;
          if (a && !k.authors.includes(a)) k.authors.push(a);
          k.tweets.push(t.id); k.tweets = k.tweets.slice(-20);
          const fresh = k.tweets.length === 1;
          const hot = !k.hot && k.authors.length >= R.hotAuthors && now - k.first <= R.hotWindowMinutes * 60;
          if (!fresh && !hot) continue;
          if (hot) k.hot = true;
          append({ ts: new Date().toISOString(), kind: fresh ? 'new' : 'hot', key, score: sc.v, why: sc.why, query: qd.id, tweet: t.url, author: a,
            followers: t.author?.followers, createdAt: t.createdAt, text: t.text.slice(0, 500), domains: ex.domains, cas: ex.cas, authors: k.authors.length });
          log(fresh ? 'CANDIDATE' : 'HOT', key, `score=${sc.v}`, `@${a}`, t.url);
          if (!firstRun) dispatch({ kind: fresh ? 'new' : 'hot', key, tweet: t.url }, log);
          found++;
        }
      }
      if (!j.next) break;
      if (p === pages - 1) { truncated = true; break; }
      cursor = j.next;
    }
    if (truncated) log('ERR', qd.id, `本轮结果超过 ${pages} 页，较早的推文没取完；可调大 radar.pagesPerQuery 或缩短 intervalMinutes`);
    if (ok) st.lastChecked[qd.id] = now;   // 只有成功才推进检查范围
  }
  st.seenTweets = [...seen].slice(-8000);
  for (const [k, v] of Object.entries(st.keys)) if (now - v.first > 7 * 86400) delete st.keys[k];   // 线索去重只保留 7 天
  st.cost.requests += req; st.cost.provider = R.provider;
  st.lastRun = new Date().toISOString();
  writeJson('radar-state.json', st);
  log('ROUND', `数据源 ${R.provider}`, `请求 ${req}`, `推文 ${got}`, `新线索 ${found}`, R.provider === 'twitterapi' ? `累计花费约 $${st.cost.usd}` : `累计调用 ${st.cost.requests} 次`);
}

// 每轮最多 8 分钟；上一轮还没结束就跳过这一轮
let busy = false;
async function guarded() {
  if (busy) { log('ERR cycle', '上一轮还没结束，跳过本轮'); return; }
  busy = true;
  let timer;
  try { await Promise.race([cycle(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('本轮超时 8 分钟')), 8 * 60_000); })]); }
  catch (e) { log('ERR cycle', e.message); }
  finally { clearTimeout(timer); busy = false; }
}
if (!process.argv.includes('--once')) setInterval(guarded, Math.max(5, R.intervalMinutes) * 60_000);
await guarded();
