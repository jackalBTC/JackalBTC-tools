// Telegram 消息格式化：纯函数，不联网，test/ 里有单元测试。
// 所有消息都按纯文本发送（不用 Markdown / HTML 解析），外部内容里的符号不会被当成格式或链接注入。

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const oneLine = s => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();

// 雷达日志一行 → { kind, text } 或 null。kind: CANDIDATE / HOT / PAID / UPDATE / LOWBNB / NOTCONNECTED / DEVMODE / ERR
// PAID：付费项目简报（字段用「｜」分隔，推送时每段一行），默认响铃
// 日志格式：<时间> <KIND> <其余…>
export function parseRadarLine(line) {
  const m = oneLine(line).match(/^\S+ \S+ (CANDIDATE|HOT|PAID|UPDATE|ERR(?: [A-Z]+)?|AGENT|ROUND)\s+(.*)$/);
  if (!m) return null;
  let kind = m[1], rest = oneLine(m[2]);
  if (kind.startsWith('ERR ')) kind = kind.slice(4);
  if (kind === 'ROUND' || kind === 'AGENT') return null;
  if (kind === 'ERR' && /本轮.*没取完|上一轮还没结束/.test(rest)) return null;   // 技术性提示不推
  const url = (rest.match(/https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/) || [])[0] || '';
  const icon = { CANDIDATE: '🆕 新线索', PAID: '💸 付费项目 · 等你决定', HOT: '🔥 多人在传', UPDATE: '📣 官推动态', LOWBNB: '⛽ BNB 不足', NOTCONNECTED: '🔌 钱包掉线', DEVMODE: '🛠 开发者模式', ERR: '⚠️ 雷达出错' }[kind] || kind;
  const body = rest.replace(url, '').replace(/\s+/g, ' ').trim();
  if (kind === 'PAID') return { kind, text: clip(`${icon}\n${body.replace(/｜/g, '\n')}\n（回 AI「打 / 不打」）`, 1200) };
  return { kind, text: clip(`${icon}\n${body}${url ? '\n' + url : ''}`, 900) };
}

// 一笔交易花了多少：cost = { valueWei, gasWei, bnbUsd }（bot 从链上回执读出来）。没有就返回空串
export function costLine(cost) {
  if (!cost || cost.gasWei == null) return '';
  const bnb = w => Number(w) / 1e18, px = Number(cost.bnbUsd) || 0;
  const amt = w => { const b = bnb(w); return `${b.toFixed(b < 0.0001 ? 7 : 5).replace(/0+$/, '').replace(/\.$/, '')} BNB${px ? `（≈$${(b * px).toFixed(2)}）` : ''}`; };
  const v = BigInt(cost.valueWei || 0), g = BigInt(cost.gasWei);
  return v > 0n ? `💰 付费 ${amt(v)} + gas ${amt(g)}，合计 ${amt(v + g)}` : `💰 免费 · gas ${amt(g)}`;
}

// 操作日志一条 → 消息（只推铸造成功、出简报 / 待确认、中止）。cost 可选：铸造成功时附上花费
export function formatEvent(e, cost) {
  if (!e || typeof e !== 'object') return null;
  const p = oneLine(e.project) + (e.wallet ? `（钱包 ${oneLine(e.wallet)}）` : ''), d = clip(oneLine(e.detail), 400);   // 多钱包时注明是哪个钱包
  const tx = /^0x[0-9a-fA-F]{64}$/.test(e.txHash || '') ? `\nhttps://bscscan.com/tx/${e.txHash}` : '';
  if (e.action === 'confirm' && /status=0x1/.test(e.detail || '')) { const c = costLine(cost); return { kind: 'MINT', text: `✅ 铸造成功：${p}\n${d}${c ? '\n' + c : ''}${tx}` }; }
  if (e.action === 'brief') return { kind: 'PENDING', text: `🤔 等你决定：${p}\n${d}\n（在看板「待你确认」或对 AI 说「打 / 不打」）` };
  if (e.action === 'abort') return { kind: 'ABORT', text: `⛔ 已中止：${p}\n${d}` };
  return null;
}

// 已参与项目的动态（data/news.json 里由 AI 写的中文总结）→ 消息
export const newsId = x => `${x?.project}|${x?.ts}|${x?.title}`;
export function formatNews(x, projects = []) {
  if (!x || typeof x !== 'object' || !x.title) return null;
  const name = (projects.find(p => p.id === x.project) || {}).name || x.project;
  const icon = { 重要: '❗', 机会: '💡', 注意: '⚠️', 一般: '📣' }[x.level] || '📣';
  const url = /^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+$/.test(x.url || '') ? '\n' + x.url : '';
  return { kind: 'NEWS', level: x.level || '一般', text: clip(`${icon} 项目动态 · ${oneLine(x.level || '一般')}\n${oneLine(name)}：${oneLine(x.title)}\n${oneLine(x.summary)}${x.action ? '\n→ ' + oneLine(x.action) : ''}${url}`, 1500) };
}
export function newsList(news, projects = [], n = 5) {
  const list = [...(news || [])].sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, n);
  if (!list.length) return '📣 还没有项目动态';
  return '📣 最近的项目动态\n\n' + list.map(x => formatNews(x, projects)?.text).filter(Boolean).join('\n\n');
}

export const KIND_LABEL = { NEWS: '项目动态', PAID: '付费项目简报', CANDIDATE: '新线索', HOT: '多人在传', UPDATE: '官推动态', MINT: '铸造成功', PENDING: '等你决定', ABORT: '中止', LOWBNB: 'BNB 不足', NOTCONNECTED: '钱包掉线', DEVMODE: '开发者模式', ERR: '雷达出错' };

// 「今天」的铸造汇总：笔数 + 项目数；多钱包（事件带 wallet 字段，没有的算主钱包）时按钱包分组
export function todaySummary(events, now = new Date(), mainLabel = '主钱包') {
  const day = now.toDateString();
  const ok = events.filter(e => e.action === 'confirm' && /status=0x1/.test(e.detail || '') && new Date(e.ts).toDateString() === day);
  const count = list => { const by = {}; for (const e of list) by[e.project] = (by[e.project] || 0) + 1; return Object.entries(by).map(([p, n]) => `· ${oneLine(p)} ×${n}`); };
  const lines = count(ok), head = `📅 今天成功铸造 ${ok.length} 笔、${lines.length} 个项目`;
  const groups = new Map();
  for (const e of ok) { const w = e.wallet ? oneLine(e.wallet) : mainLabel; groups.set(w, [...(groups.get(w) || []), e]); }
  if (groups.size < 2) return head + (lines.length ? '\n' + lines.join('\n') : '');
  return `${head}（${groups.size} 个钱包）` + [...groups].map(([w, list]) => { const l = count(list); return `\n\n【${w}】${list.length} 笔、${l.length} 个项目\n${l.join('\n')}`; }).join('');
}

export function pendingList(projects) {
  const list = (projects || []).filter(p => p.status === '待确认');
  if (!list.length) return '🙆 现在没有等你决定的项目';
  return `🤔 等你决定（${list.length}）\n` + list.slice(0, 10).map(p => `· ${clip(oneLine(p.name || p.id), 40)}：${clip(oneLine(p.card?.question || p.reason || ''), 120)}`).join('\n');
}

export { clip, oneLine };
