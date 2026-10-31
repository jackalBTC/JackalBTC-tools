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
import { baw, rpc, bnbUsd } from '../lib/chain.mjs';
import { listWallets, readWallets, envFor, sessionOk } from '../lib/wallets.mjs';
import { readEvents } from '../lib/events.mjs';
import { parseRadarLine, formatEvent, todaySummary, pendingList, formatNews, newsList, newsId, KIND_LABEL, clip, oneLine } from './format.mjs';

const T = config.telegram || {};
const log = (...a) => console.log(new Date().toLocaleString('zh-CN', { hour12: false }), ...a);
const token = getSecret('telegram');
if (!token) { log('ERR', '没有 Telegram 机器人 token，运行 npm run setup 配置。配好前每 10 分钟检查一次。'); }
const API = m => `https://api.telegram.org/bot${getSecret('telegram')}/${m}`;
const allowed = new Set((T.chatIds || []).map(String));
// 默认推送的类型（config 的 telegram.notify 可覆盖）。免费铸造成功默认不逐笔推（telegram.freeMints: true 打开），看每晚总结
const notifyKinds = new Set(T.notify || ['NEWS', 'PAID', 'CANDIDATE', 'HOT', 'MINT', 'PENDING', 'ABORT', 'LOWBNB', 'NOTCONNECTED', 'DEVMODE', 'ERR']);
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
// loud=false 时静音推送（不响铃）。哪些算重要见 LOUD：钱包掉线 / BNB 不足 / 开发者模式 / 等你决定 / 「重要」级动态（含价格提醒）
const LOUD = new Set(T.loudKinds || ['PENDING', 'PAID', 'LOWBNB', 'NOTCONNECTED', 'DEVMODE', 'NEWS:重要']);
async function send(text, chatIds = [...allowed], loud = true) {
  const now = Date.now();
  while (sent.length && now - sent[0] > 60_000) sent.shift();
  if (sent.length >= 20) { dropped++; return; }
  if (dropped) { const n = dropped; dropped = 0; await send(`（刚才有 ${n} 条提醒因为太密集没发出，请看看板）`, chatIds); }
  sent.push(now);
  for (const id of chatIds) await tg('sendMessage', { chat_id: id, text: clip(text, 3800), disable_web_page_preview: true, disable_notification: !loud }).catch(e => log('ERR', e.message));
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
  for (const l of newLines(RADAR_LOG, 'radarOffset')) { const m = parseRadarLine(l); if (m && notifyKinds.has(m.kind)) msgs.push({ text: m.text, loud: LOUD.has(m.kind) }); }
  const plist = readJson('projects.json', []) || [];
  const pnames = Object.fromEntries(plist.map(p => [p.id, p.name]));   // 日志存项目 id，推送用真名
  const quiet = new Set(plist.filter(p => p.quiet).map(p => p.id));   // 台账里标了 quiet: true 的项目不逐笔推送，看每晚总结
  for (const l of newLines(dataFile('events.jsonl'), 'eventsOffset')) {
    try {
      const e = JSON.parse(l); if (quiet.has(e.project)) continue; if (pnames[e.project]) e.project = pnames[e.project];
      const m = formatEvent(e);
      if (!m || !notifyKinds.has(m.kind)) continue;
      if (m.kind === 'MINT') {   // 默认只推付费的铸造成功；免费的看每晚总结
        const c = await txCost(e.txHash);
        if (!T.freeMints && !(c && BigInt(c.valueWei || 0) > 0n)) continue;
        msgs.push({ text: (formatEvent(e, c) || m).text, loud: LOUD.has(m.kind) });
      } else msgs.push({ text: m.text, loud: LOUD.has(m.kind) });
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
      const m = formatNews(x, projects); if (m) msgs.push({ text: m.text, loud: LOUD.has('NEWS:' + (x.level || '一般')) });
    }
    st.newsSeen = [...seen].slice(-2000);
  }
  writeJson(STATE, st);
  for (const m of msgs) await send(m.text, undefined, m.loud);
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
  '/holdings 持仓和现值（要开着看板）',
  '/pnl 战绩：已实现盈亏',
  '也可以直接发中文：余额、持仓、战绩、今天、指令',
  '每晚 21:00（北京时间）自动发一份当天总结。',
  '',
  '我不能下单或花钱；要打 / 不打，请在 Claude Code 等 AI 助手里说。',
].join('\n');
// 一个钱包一段：登录状态（会话是不是它）、BNB、开发者模式
async function walletBlock(w, multi) {
  const env = envFor(w), e = await sessionOk(w).catch(x => x.message);
  const lines = multi ? [`【${oneLine(w.label && w.label !== w.id ? `${w.id}（${w.label}）` : w.id)}${w.main ? ' · 主' : w.allowPaid ? ' · 允许付费' : ' · 只打免费'}】`] : [];
  lines.push(`🔐 钱包：${e ? '未登录 / 会话不对（' + clip(oneLine(e), 80) + '）' : '已登录'}`);
  try {
    const bnb = Number(BigInt(await rpc('eth_getBalance', [w.address, 'latest']))) / 1e18;
    lines.push(`⛽ BNB：${bnb.toFixed(4)}${bnb < config.alerts.lowBnb ? '（偏低，请补 gas）' : ''}`);
  } catch {}
  const dm = e ? null : (await baw(['wallet', 'settings'], env))?.data?.devMode;
  if (dm) lines.push(`🛠 开发者模式：${dm.enabled ? '开' : '关'}${dm.expiresAt ? '，到期 ' + dm.expiresAt : ''}`);
  return lines.join('\n');
}
async function status() {
  let WS, lines;
  try { WS = await listWallets(); lines = [(await Promise.all(WS.map(w => walletBlock(w, WS.length > 1)))).join('\n\n')]; }
  catch (e) { lines = ['⚠️ ' + clip(oneLine(e.message), 300)]; WS = []; }
  if (WS.length > 1) lines.push('');
  const rs = readJson('radar-state.json', {});
  lines.push(`📡 雷达上一轮：${rs.lastRun ? new Date(rs.lastRun).toLocaleString('zh-CN', { hour12: false }) : '还没跑过'}（数据源 ${config.radar.provider}）`);
  lines.push(`💸 自动付费：${config.spending.allowAutoPaid ? `开（${config.spending.maxDailyBnb != null ? `每天 ≤ ${config.spending.maxDailyBnb} BNB` : '不设每日上限'}）` : '关（只打免费）'}${WS.length > 1 ? '；副钱包只打免费（设了 allowPaid 的除外）' : ''}`);
  return lines.join('\n');
}
function recentRadar() {
  let lines = [];
  try { lines = fs.readFileSync(dataFile('radar-candidates.jsonl'), 'utf8').trim().split('\n').slice(-30); } catch {}
  const items = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(x => x && x.kind !== 'update').slice(-5).reverse();
  if (!items.length) return '📡 还没有雷达线索';
  return '📡 最近的线索\n' + items.map(x => `· ${oneLine(x.key)}（${(x.why || []).slice(0, 3).join('、')}）\n  ${x.tweet}`).join('\n');
}
// 持仓 / 战绩：读本机看板的接口（看板没开就提示）。只读。
const DASH = T.dashboard || 'http://127.0.0.1:8790';
const getDash = async p => (await fetch(DASH + p, { signal: AbortSignal.timeout(20000) })).json();
const usdOf = async (amt, cur) => cur === 'BNB' ? amt * await bnbUsd() : ['USDT', 'USD', 'USDC'].includes(cur) ? amt : null;
async function holdings() {
  try {
    const { positions = [] } = await getDash('/api/positions?w=all');
    const rows = [];
    for (const p of positions) {
      if (p.writtenOff || !(p.value > 0) || !isFinite(p.value) || p.value > 1e9) continue;
      const usd = await usdOf(p.value, p.currency); if (usd == null) continue;
      rows.push({ usd, line: `· ${oneLine(p.name)}：${p.kind === 'token' ? Math.round(p.held).toLocaleString('en-US') + ' 枚' : p.held + ' 张'} ≈ $${usd.toFixed(2)}${p.wallets ? '（' + p.wallets.join('、') + '）' : ''}` });
    }
    rows.sort((a, b) => b.usd - a.usd);
    const tot = rows.reduce((a, r) => a + r.usd, 0);
    return rows.length ? `💼 有报价的持仓 ${rows.length} 项，合计约 $${tot.toFixed(2)}\n` + rows.slice(0, 15).map(r => r.line).join('\n') + (rows.length > 15 ? `\n…还有 ${rows.length - 15} 项` : '') : '💼 目前没有有报价的持仓';
  } catch { return '💼 读不到看板数据（看板服务没开？）'; }
}
async function pnl() {
  try {
    const { list = [] } = await getDash('/api/realized?w=all');
    const px = await bnbUsd(), u = c => c ? (c.USDT || 0) + (c.USD || 0) + (c.BNB || 0) * px : 0;
    const tot = list.reduce((a, r) => a + u(r.proceeds) - u(r.cost), 0);
    const recent = list.slice(-6).reverse().map(r => `· ${oneLine(r.name).slice(0, 40)}：${u(r.proceeds) - u(r.cost) >= 0 ? '+' : ''}$${(u(r.proceeds) - u(r.cost)).toFixed(2)}`);
    return `📈 已实现 ${list.length} 笔，合计 ${tot >= 0 ? '+' : ''}$${tot.toFixed(2)}（BNB 按 $${px.toFixed(0)}）\n最近：\n` + recent.join('\n');
  } catch { return '📈 读不到看板数据（看板服务没开？）'; }
}
const ALIAS = { '余额': '/status', '钱包': '/status', '持仓': '/holdings', '战绩': '/pnl', '盈亏': '/pnl', '今天': '/today', '指令': '/help', '帮助': '/help' };
async function handle(msg) {
  const chat = String(msg.chat?.id), text = String(msg.text || '').trim();
  if (!allowed.has(chat)) return;   // 不是你的聊天：完全不回应
  if (msg.date && Date.now() / 1000 - msg.date > 120) return;   // 超过 2 分钟的旧消息（机器人重启时积压的）不执行
  const first = text.split(/[\s@]/)[0];
  const cmd = (ALIAS[first] || first).toLowerCase();
  let reply;
  if (cmd === '/status') reply = await status();
  else if (cmd === '/pending') reply = pendingList(readJson('projects.json', []));
  else if (cmd === '/today') { let main = '主钱包'; try { main = readWallets().find(w => w.main).id; } catch {} const pn = Object.fromEntries((readJson('projects.json', []) || []).map(p => [p.id, p.name])); reply = todaySummary(readEvents(5000).map(e => pn[e.project] ? { ...e, project: pn[e.project] } : e), new Date(), main); }
  else if (cmd === '/radar') reply = recentRadar();
  else if (cmd === '/holdings') reply = await holdings();
  else if (cmd === '/pnl') reply = await pnl();
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
// 每晚 21:00（北京时间）静音发一份总结：今天铸造了什么 + 战绩 + 持仓
setInterval(async () => {
  const bj = new Date(Date.now() + 8 * 3600_000), day = bj.toISOString().slice(0, 10);
  if (bj.getUTCHours() < 21 || st.dailySent === day || !getSecret('telegram') || !allowed.size) return;
  st.dailySent = day; writeJson(STATE, st);
  let main = '主钱包'; try { main = readWallets().find(w => w.main).id; } catch {}
  const pn = Object.fromEntries((readJson('projects.json', []) || []).map(p => [p.id, p.name]));
  const parts = ['🌙 今日总结 ' + day, todaySummary(readEvents(5000).map(e => pn[e.project] ? { ...e, project: pn[e.project] } : e), new Date(), main), await pnl(), await holdings()];
  await send(parts.join('\n\n'), undefined, false).catch(e => log('ERR', e.message));
}, 60_000);
pollLoop();
