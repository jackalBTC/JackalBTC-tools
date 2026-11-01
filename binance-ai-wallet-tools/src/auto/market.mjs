// Element 市场监控（只读：不授权、不挂单、不发交易）。
// 为什么不看「有多少人授权给交易合约」：授权 ≠ 有人买。实测大多数「疑似开了市场」的系列几天零成交，或只有几毛钱的求购。
// 所以只看 Element 链上真实事件：成交、链上求购（只算收我们手上编号的）、撤单。
// 报的规则：近 3 天 ≥ minFills 笔成交且最近一笔 ≥ minFillUsd 美元；或有效求购 ≥ minBidUsd 美元。每个系列只报一次（写一条「重要」项目动态）。
// 结果存在 data/market-watch.json，看板据此把持仓分到「能卖 / 有市场没买家」。
import { config, readJson, writeJson } from '../lib/config.mjs';
import { rpc, getLogs, bnbUsd } from '../lib/chain.mjs';
import { listWallets, readWatch } from '../lib/wallets.mjs';
import { ELEMENT, TOPICS, parseElementLog, marketVerdict } from '../lib/element.mjs';
import { log, addNews, DRY } from './common.mjs';

const KEEP_MS = 7 * 86400_000;
let at = 0;

export async function marketTick() {
  const M = config.marketWatch;
  if (!M?.enabled || Date.now() - at < M.everyMinutes * 60_000) return;
  at = Date.now();
  // 要盯的系列：所有钱包持有、没核销、没配链上挂单扫描（listing-scan 已经有地板价）的 NFT 系列
  const cols = new Map(), mine = new Map();
  for (const w of await listWallets()) for (const c of readWatch(w).collections || []) {
    if (c.writtenOff || !/^0x[0-9a-fA-F]{40}$/.test(c.contract || '') || c.market?.type === 'listing-scan') continue;
    const k = c.contract.toLowerCase(); if (!cols.has(k)) cols.set(k, { id: c.id, name: c.name || c.id });
    for (const id of c.ids || []) (mine.get(k) || mine.set(k, new Set()).get(k)).add(String(id));
  }
  if (!cols.size) return;
  const st = readJson('market-watch.json', {}); st.el ||= {}; st.used ||= {}; st.reported ||= {};
  const head = Number(await rpc('eth_blockNumber', []));
  const from = Math.max(st.last == null ? 0 : st.last + 1, head - M.firstBlocks);   // 停了很久也只补最近 firstBlocks 块
  if (from > head) return;
  // 区块时间：用实际出块速度估算每条事件的时间（BSC 出块间隔升级过几次，不写死）
  const back = Math.min(10_000, head);
  const [bh, bo] = await Promise.all([rpc('eth_getBlockByNumber', ['0x' + head.toString(16), false]), rpc('eth_getBlockByNumber', ['0x' + (head - back).toString(16), false])]);
  const tHead = Number(bh.timestamp) * 1000, blkMs = back ? (tHead - Number(bo.timestamp) * 1000) / back : 1000;
  // 任何一段失败整轮作废（抛错），区块进度不前进，下一轮从原位置重来
  const logs = await getLogs({ address: ELEMENT, topics: [[TOPICS.sell, TOPICS.buy, TOPICS.bid, TOPICS.cancel]] }, from, head);
  const px = await bnbUsd().catch(() => null);
  if (!px) { log('ERR market', '读不到 BNB 价格，下一轮再算'); return; }
  let n = 0;
  for (const l of logs) {
    const e = parseElementLog(l, new Set(cols.keys()));
    if (!e) continue;
    if (e.type === 'cancel' || e.type === 'used' || e.type === 'fill') st.used[e.key] = Date.now();   // 撤掉 / 成交过的单不再算有效求购
    if (e.type !== 'fill' && e.type !== 'bid') continue;
    e.ts = Math.round(tHead - (head - e.blk) * blkMs); delete e.blk;
    (st.el[e.nft] ||= []).push(e); n++;
  }
  for (const [k, t] of Object.entries(st.used)) if (Date.now() - t > KEEP_MS) delete st.used[k];
  for (const c of Object.keys(st.el)) { st.el[c] = st.el[c].filter(e => Date.now() - e.ts < KEEP_MS || (e.type === 'bid' && e.exp * 1000 > Date.now())); if (!st.el[c].length) delete st.el[c]; }
  st.last = head; st.at = new Date().toISOString();
  const found = [];
  for (const [c, info] of cols) {
    if (st.reported[c]) continue;
    const v = marketVerdict(st.el[c], { used: st.used, ourIds: mine.get(c), bnbUsd: px, minFills: M.minFills, minFillUsd: M.minFillUsd, minBidUsd: M.minBidUsd });
    if (!v) continue;
    st.reported[c] = new Date().toISOString();
    found.push({ ...info, contract: c, text: v.text });
  }
  if (!DRY) writeJson('market-watch.json', st);
  log('MARKET', `扫了 ${head - from + 1} 块，${n} 条相关事件，${found.length} 个系列值得看`);
  if (!found.length) return;
  const one = found.length === 1;   // 一轮发现多个就合成一条，免得手机连响
  addNews(one ? found[0].id : 'market', '重要', one ? `${found[0].name} 在 Element 有真实成交 / 求购` : `${found.length} 个 NFT 在 Element 有真实成交 / 求购`,
    'Element 链上事件（成交价是真实成交；挂卖单在链下，地板价要去 Element 页面看）：\n' + found.map(x => `${x.name}：${x.text}`).join('\n'),
    '要不要卖，在 AI 对话里说；工具不会自动授权或挂单');
  for (const x of found) log('MARKET', x.name, x.contract, x.text);
}
