#!/usr/bin/env node
// Telegram 机器人：把雷达和铸造的消息推到你的 Telegram，并回答几个只读查询命令。
// 安全设计：
//   - 只读：没有任何会花钱 / 发交易 / 改配置的命令；机器人 token 泄露也动不了钱包。
//   - 只认 config.telegram.chatIds 里的聊天；别人发来的消息一律不回。
//   - 纯文本发送（不解析 Markdown / HTML），外部内容不会被当成格式或按钮。
//   - token 只从环境变量 TELEGRAM_BOT_TOKEN 或 ~/.config/binance-ai-wallet-tools/secrets.json 读，不打印、不写日志。
// 用法：node src/telegram/bot.mjs    （npm run service install 会在配置了 token 时一起托管）
import fs from 'node:fs';
import path from 'node:path';
import { config, getSecret, readJson, writeJson, ROOT, dataFile } from '../lib/config.mjs';
import { baw, rpc, walletAddress, bnbUsd } from '../lib/chain.mjs';
import { readEvents } from '../lib/events.mjs';
import { parseRadarLine, formatEvent, todaySummary, pendingList, formatNews, newsList, newsId, KIND_LABEL, clip, oneLine } from './format.mjs';

const T = config.telegram || {};
const log = (...a) => console.log(new Date().toLocaleString('zh-CN', { hour12: false }), ...a);
const token = getSecret('telegram');
if (!token) { log('ERR', '没有 Telegram 机器人 token，运行 npm run setup 配置。配好前每 10 分钟检查一次。'); }
const API = m => `https://api.telegram.org/bot${getSecret('telegram')}/${m}`;
const allowed = new Set((T.chatIds || []).map(String));
const notifyKinds = new Set(T.notify || ['NEWS', 'CANDIDATE', 'HOT', 'MINT', 'PENDING', 'ABORT', 'LOWBNB', 'NOTCONNECTED', 'DEVMODE', 'ERR']);
const newsLevels = new Set(T.newsLevels || ['重要', '机会', '注意']);
const RADAR_LOG = T.radarLog ? path.resolve(ROOT, T.radarLog) : path.join(ROOT, 'logs/radar.log');   // 可在配置里指定雷达日志位置

async function tg(method, body) {
  const r = await fetch(API(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(method === 'getUpdates' ? 70000 : 20000) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method} 失败：${String(j.description || r.status).slice(0, 120)}`);   // 不把 token 带进错误信息
  return j.result;
}

// ---------- 发送（带简单限流：每分钟最多 20 条，超出的合并成一条摘要） ----------
const sent = [];
let dropped = 0;
async function send(text, chatIds = [...allowed]) {
  const now = Date.now();
  while (sent.length && now - sent[0] > 60_000) sent.shift();
  if (sent.length >= 20) { dropped++; return; }
  if (dropped) { const n = dropped; dropped = 0; await send(`（刚才有 ${n} 条提醒因为太密集没发出，请看看板）`, chatIds); }
  sent.push(now);
  for (const id of chatIds) await tg('sendMessage', { chat_id: id, text: clip(text, 3800), disable_web_page_preview: true }).catch(e => log('ERR', e.message));
}

// ---------- 推送：跟踪雷达日志和操作日志的新行 ----------
const STATE = 'telegram-state.json';
const st = readJson(STATE, {});
function newLines(file, key) {
  let size = 0; try { size = fs.statSync(file).size; } catch { return []; }
  if (st[key] == null || st[key] > size) { st[key] = size; return []; }   // 第一次启动 / 文件被轮转：从末尾开始，不补发历史
  if (size === st[key]) return [];
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(Math.min(size - st[key], 1 << 20));
  fs.readSync(fd, buf, 0, buf.length, st[key]); fs.closeSync(fd);
  const text = buf.toString('utf8'), last = text.lastIndexOf('\n');
  if (last < 0) return [];
  st[key] += Buffer.byteLength(text.slice(0, last + 1));
  return text.slice(0, last).split('\n').filter(Boolean);
}
// 铸造花了多少：交易里付的 BNB（value）+ gas（gasUsed × 实际 gas 价），读不到就不写
async function txCost(hash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash || '')) return null;
  try {
    const [tx, rc] = await Promise.all([rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash])]);
    if (!tx || !rc) return null;
    const gasWei = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice || tx.gasPrice || 0);
    return { valueWei: BigInt(tx.value || 0), gasWei, bnbUsd: await bnbUsd().catch(() => 0) };
  } catch { return null; }
}
async function pushTick() {
  if (!getSecret('telegram') || !allowed.size) return;
  const msgs = [];
  for (const l of newLines(RADAR_LOG, 'radarOffset')) { const m = parseRadarLine(l); if (m && notifyKinds.has(m.kind)) msgs.push(m.text); }
  for (const l of newLines(dataFile('events.jsonl'), 'eventsOffset')) {
    try {
      const e = JSON.parse(l), m = formatEvent(e);
      if (!m || !notifyKinds.has(m.kind)) continue;
      msgs.push(m.kind === 'MINT' ? (formatEvent(e, await txCost(e.txHash)) || m).text : m.text);
    } catch {}
  }
  // 项目动态：news.json 里新出现的条目（第一次运行只记下已有的，不补发）
  const news = readJson('news.json', []);
  if (Array.isArray(news)) {
    const seen = new Set(st.newsSeen || []), first = !st.newsSeen;
    const projects = readJson('projects.json', []);
    for (const x of news) {
      const id = newsId(x);
      if (seen.has(id)) continue;
      seen.add(id);
      if (first || !notifyKinds.has('NEWS') || !newsLevels.has(x.level || '一般')) continue;
      const m = formatNews(x, projects); if (m) msgs.push(m.text);
    }
    st.newsSeen = [...seen].slice(-2000);
  }
  writeJson(STATE, st);
  for (const m of msgs) await send(m);
}

// ---------- 查询命令（只读） ----------
const HELP = [
  '我是你的币安 AI 钱包工具机器人（只读）。',
  '/status 钱包、余额、雷达状态',
  '/pending 等你决定的项目',
  '/today 今天铸造了什么',
  '/news 已参与项目的最新动态',
  '/radar 最近的雷达线索',
  '/settings 我会推送哪些提醒',
  '',
  '我不能下单或花钱；要打 / 不打，请在 Claude Code 等 AI 助手里说。',
].join('\n');
async function status() {
  const s = await baw(['wallet', 'status']);
  const lines = [`🔐 钱包：${s?.data?.status === 'CONNECTED' ? '已登录' : '未登录（' + (s?.data?.status || '未知') + '）'}`];
  try {
    const w = await walletAddress();
    const bnb = Number(BigInt(await rpc('eth_getBalance', [w, 'latest']))) / 1e18;
    lines.push(`⛽ BNB：${bnb.toFixed(4)}${bnb < config.alerts.lowBnb ? '（偏低，请补 gas）' : ''}`);
  } catch {}
  const dm = (await baw(['wallet', 'settings']))?.data?.devMode;
  if (dm) lines.push(`🛠 开发者模式：${dm.enabled ? '开' : '关'}${dm.expiresAt ? '，到期 ' + dm.expiresAt : ''}`);
  const rs = readJson('radar-state.json', {});
  lines.push(`📡 雷达上一轮：${rs.lastRun ? new Date(rs.lastRun).toLocaleString('zh-CN', { hour12: false }) : '还没跑过'}（数据源 ${config.radar.provider}）`);
  lines.push(`💸 自动付费：${config.spending.allowAutoPaid ? `开（每天 ≤ ${config.spending.maxDailyBnb} BNB）` : '关（只打免费）'}`);
  return lines.join('\n');
}
function recentRadar() {
  let lines = [];
  try { lines = fs.readFileSync(dataFile('radar-candidates.jsonl'), 'utf8').trim().split('\n').slice(-30); } catch {}
  const items = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(x => x && x.kind !== 'update').slice(-5).reverse();
  if (!items.length) return '📡 还没有雷达线索';
  return '📡 最近的线索\n' + items.map(x => `· ${oneLine(x.key)}（${(x.why || []).slice(0, 3).join('、')}）\n  ${x.tweet}`).join('\n');
}
async function handle(msg) {
  const chat = String(msg.chat?.id), text = String(msg.text || '').trim();
  if (!allowed.has(chat)) return;   // 不是你的聊天：完全不回应
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  let reply;
  if (cmd === '/status') reply = await status();
  else if (cmd === '/pending') reply = pendingList(readJson('projects.json', []));
  else if (cmd === '/today') reply = todaySummary(readEvents(5000));
  else if (cmd === '/radar') reply = recentRadar();
  else if (cmd === '/news') reply = newsList(readJson('news.json', []), readJson('projects.json', []));
  else if (cmd === '/settings') reply = '🔔 会推送：' + [...notifyKinds].map(k => KIND_LABEL[k] || k).join('、') + `\n项目动态推送等级：${[...newsLevels].join('、')}` + '\n改 config/config.json 的 telegram.notify / newsLevels 后重启机器人生效。';
  else reply = HELP;
  await send(reply, [chat]);
}

async function pollLoop() {
  for (;;) {
    if (!getSecret('telegram')) { await new Promise(r => setTimeout(r, 600_000)); continue; }
    try {
      const ups = await tg('getUpdates', { offset: (st.updateId || 0) + 1, timeout: 50, allowed_updates: ['message'] });
      for (const u of ups) { st.updateId = u.update_id; if (u.message) await handle(u.message).catch(e => log('ERR', e.message)); }
      if (ups.length) writeJson(STATE, st);
    } catch (e) { log('ERR', e.message); await new Promise(r => setTimeout(r, 10_000)); }
  }
}

if (token && !allowed.size) log('ERR', '还没有配置 chatIds：运行 npm run setup，按提示给机器人发一条消息完成绑定。');
log('START', `Telegram 机器人启动，绑定 ${allowed.size} 个聊天，推送：${[...notifyKinds].join(',')}`);
setInterval(() => pushTick().catch(e => log('ERR', e.message)), 5000);
pollLoop();
