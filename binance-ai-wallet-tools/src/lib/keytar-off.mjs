// 让 baw 不用系统钥匙串：baw 的登录凭证在钥匙串里的名字是固定的（"baw" / "agentSessionId"），
// 第二个钱包一登录就会把第一个顶掉。屏蔽 @github/keytar 后，baw 会退回自带的备用方式：
// 把会话存在 $BINANCE_BAW_DIR/session.json。只用于副钱包（src/lib/wallets.mjs 通过 NODE_OPTIONS=--import 加载）。
import * as mod from 'node:module';
const MSG = 'keytar disabled for multi-wallet';
if (mod.registerHooks) {   // Node 22.15+ / 23.5+：同步钩子
  mod.registerHooks({ resolve(s, c, next) { if (s === '@github/keytar') throw new Error(MSG); return next(s, c); } });
} else {                   // Node 20.6+：异步 loader
  mod.register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, next) { if (s === '@github/keytar') throw new Error(${JSON.stringify(MSG)}); return next(s, c); }`));
}
