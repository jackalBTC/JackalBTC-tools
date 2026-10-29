// 数据源二：xAI Grok API 的 x_search 工具（由 Grok 去 X 上搜，再按我们要求的格式整理成 JSON）。
// 注册与价格见 docs/providers.md。Key 从环境变量 XAI_API_KEY 或 ~/.config/binance-ai-wallet-tools/secrets.json 读取。
//
// 和 twitterapi.io 的区别：结果是模型整理出来的，可能漏帖、合并或改写文字；所以只把它当「线索」，
// 合约地址和链接仍要回到原帖 / 官网 / 链上核实。按调用计费，查询越多越贵。
import { getSecret, config } from '../../lib/config.mjs';

const API = 'https://api.x.ai/v1/responses';
export const name = 'grok';

export function ready() { return !!getSecret('xai'); }

const ymd = unix => new Date(unix * 1000).toISOString().slice(0, 10);

function extractText(j) {
  const parts = [];
  for (const item of j.output || []) {
    if (item.type === 'message') for (const c of item.content || []) { if (c.type === 'output_text' && c.text) parts.push(c.text); }
    else if (item.text) parts.push(item.text);
  }
  return parts.join('\n');
}
function firstJsonArray(s) {
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  try { const v = JSON.parse(s.slice(a, b + 1)); return Array.isArray(v) ? v : []; } catch { return []; }
}

// 返回格式同 twitterapi.mjs：{ tweets, next: null, billed: 1 }（billed 按调用次数计）
export async function search({ query, sinceUnix, handles }) {
  const key = getSecret('xai');
  if (!key) throw new Error('没有配置 xAI（Grok）的 Key');
  const tool = { type: 'x_search', from_date: ymd(sinceUnix) };
  if (handles?.length) tool.allowed_x_handles = handles.slice(0, 10);
  const ask = [
    'Search X for posts matching the query below. Only include posts published at or after',
    new Date(sinceUnix * 1000).toISOString() + '.',
    handles?.length ? `Only posts from these accounts: ${handles.join(', ')}.` : `Query: ${query}`,
    'Return ONLY a JSON array (no prose, no markdown), newest first, at most 40 items. Each item:',
    '{"url":"https://x.com/<user>/status/<id>","author":"<username without @>","followers":<number or null>,"created_at":"<ISO time>","text":"<the post text, verbatim, including any URLs and 0x addresses>"}',
    'Do not invent posts. If nothing matches, return [].',
  ].join(' ');
  const r = await fetch(API, {
    method: 'POST', signal: AbortSignal.timeout(120000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.radar.grokModel || 'grok-4-1-fast', input: [{ role: 'user', content: ask }], tools: [tool], store: false }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`HTTP ${r.status} ${String(j.error?.message || j.error || '').slice(0, 160)}`);
  const items = firstJsonArray(extractText(j));
  // 模型输出不可信：链接只接受标准的 X 帖子地址，用户名只接受 X 允许的字符
  const URL_RE = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})$/;
  const tweets = items.map(x => {
    const m = String(x?.url || '').trim().match(URL_RE);
    if (!m) return null;
    return { id: m[2], url: `https://x.com/${m[1]}/status/${m[2]}`, text: String(x.text || '').slice(0, 2000), createdAt: x.created_at || null,
      author: { userName: m[1], followers: Number.isFinite(+x.followers) ? +x.followers : null } };
  }).filter(t => t && (!t.createdAt || Date.parse(t.createdAt) / 1000 >= sinceUnix - 3600));
  return { tweets, next: null, billed: 1 };
}
