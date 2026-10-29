// Telegram 消息格式化：纯函数，不联网，test/ 里有单元测试。
// 所有消息都按纯文本发送（不用 Markdown / HTML 解析），外部内容里的符号不会被当成格式或链接注入。

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const oneLine = s => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();

// 雷达日志一行 → { kind, text } 或 null。kind: CANDIDATE / HOT / UPDATE / LOWBNB / NOTCONNECTED / DEVMODE / ERR
// 日志格式：<时间> <KIND> <其余…>
export function parseRadarLine(line) {
  const m = oneLine(line).match(/^\S+ \S+ (CANDIDATE|HOT|UPDATE|ERR(?: [A-Z]+)?|AGENT|ROUND)\s+(.*)$/);
  if (!m) return null;
  let kind = m[1], rest = oneLine(m[2]);
  if (kind.startsWith('ERR ')) kind = kind.slice(4);
  if (kind === 'ROUND' || kind === 'AGENT') return null;
  if (kind === 'ERR' && /本轮.*没取完|上一轮还没结束/.test(rest)) return null;   // 技术性提示不推
  const url = (rest.match(/https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/) || [])[0] || '';
  const icon = { CANDIDATE: '🆕 新线索', HOT: '🔥 多人在传', UPDATE: '📣 官推动态', LOWBNB: '⛽ BNB 不足', NOTCONNECTED: '🔌 钱包掉线', DEVMODE: '🛠 开发者模式', ERR: '⚠️ 雷达出错' }[kind] || kind;
  const body = rest.replace(url, '').replace(/\s+/g, ' ').trim();
  return { kind, text: clip(`${icon}\n${body}${url ? '\n' + url : ''}`, 900) };
}

// 操作日志一条 → 消息（只推铸造成功、出简报 / 待确认、中止）
export function formatEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const p = oneLine(e.project), d = clip(oneLine(e.detail), 400);
  const tx = /^0x[0-9a-fA-F]{64}$/.test(e.txHash || '') ? `\nhttps://bscscan.com/tx/${e.txHash}` : '';
  if (e.action === 'confirm' && /status=0x1/.test(e.detail || '')) return { kind: 'MINT', text: `✅ 铸造成功：${p}\n${d}${tx}` };
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

export const KIND_LABEL = { NEWS: '项目动态', CANDIDATE: '新线索', HOT: '多人在传', UPDATE: '官推动态', MINT: '铸造成功', PENDING: '等你决定', ABORT: '中止', LOWBNB: 'BNB 不足', NOTCONNECTED: '钱包掉线', DEVMODE: '开发者模式', ERR: '雷达出错' };

// 「今天」的铸造汇总
export function todaySummary(events, now = new Date()) {
  const day = now.toDateString();
  const ok = events.filter(e => e.action === 'confirm' && /status=0x1/.test(e.detail || '') && new Date(e.ts).toDateString() === day);
  const by = {};
  for (const e of ok) by[e.project] = (by[e.project] || 0) + 1;
  const lines = Object.entries(by).map(([p, n]) => `· ${oneLine(p)} ×${n}`);
  return `📅 今天成功铸造 ${ok.length} 笔、${lines.length} 个项目${lines.length ? '\n' + lines.join('\n') : ''}`;
}

export function pendingList(projects) {
  const list = (projects || []).filter(p => p.status === '待确认');
  if (!list.length) return '🙆 现在没有等你决定的项目';
  return `🤔 等你决定（${list.length}）\n` + list.slice(0, 10).map(p => `· ${clip(oneLine(p.name || p.id), 40)}：${clip(oneLine(p.card?.question || p.reason || ''), 120)}`).join('\n');
}

export { clip, oneLine };
