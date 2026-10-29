// 数据源一：twitterapi.io（第三方 X 数据接口，按返回的推文条数计费）。
// 注册与价格见 docs/providers.md。Key 从环境变量 TWITTERAPI_KEY 或 ~/.config/binance-ai-wallet-tools/secrets.json 读取。
import { getSecret } from '../../lib/config.mjs';

const API = 'https://api.twitterapi.io/twitter/tweet/advanced_search';
export const name = 'twitterapi';
export const PRICE_PER_TWEET = 0.00015;   // 官网标价约 $0.15 / 1000 条，以官网为准

export function ready() { return !!getSecret('twitterapi'); }

// 返回 { tweets: [{ id, url, text, createdAt, author: { userName, followers } }], next: cursor|null, billed: 条数 }
export async function search({ query, sinceUnix, handles, cursor = '' }) {
  const key = getSecret('twitterapi');
  if (!key) throw new Error('没有配置 twitterapi.io 的 Key');
  const q = handles?.length ? `(${handles.map(h => 'from:' + h).join(' OR ')})` : query;
  const u = new URL(API);
  u.searchParams.set('query', `${q} since_time:${sinceUnix}`);
  u.searchParams.set('queryType', 'Latest');
  u.searchParams.set('cursor', cursor);
  let last;
  for (let t = 0; t < 2; t++) {
    try {
      const r = await fetch(u, { headers: { 'X-API-Key': key }, signal: AbortSignal.timeout(30000) });
      const j = await r.json();
      if (!r.ok || !Array.isArray(j.tweets)) throw new Error(`HTTP ${r.status} ${String(j.message || j.error || '').slice(0, 120)}`);
      return {
        tweets: j.tweets.filter(t => !t.retweeted_tweet).map(t => ({
          id: String(t.id), url: t.url || `https://x.com/i/status/${t.id}`, text: t.text || '', createdAt: t.createdAt,
          author: { userName: t.author?.userName, followers: t.author?.followers ?? null },
          entities: t.entities || null,
        })),
        next: j.has_next_page ? j.next_cursor : null,
        billed: Math.max(j.tweets.length, 1),
      };
    } catch (e) { last = e; await new Promise(r => setTimeout(r, 3000)); }
  }
  throw last;
}
