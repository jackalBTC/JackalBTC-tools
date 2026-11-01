#!/usr/bin/env node
// 付费项目防骗检查（只读链，不发交易）。规则见 src/lib/devcheck.mjs 和 docs/security.md。
// 用法:
//   node src/cli/devcheck.mjs <合约> [<合约> …] [--json]   检查；有任何一个「拦」时退出码是 2
//   node src/cli/devcheck.mjs --thresholds                  只看本机门槛（第一次会随机生成，存在 data/thresholds.json）
import { isAddr } from '../lib/chain.mjs';
import { devCheck, thresholds } from '../lib/devcheck.mjs';

const args = process.argv.slice(2), JSON_OUT = args.includes('--json');
const bad = args.filter(a => a.startsWith('-') && !['--json', '--thresholds'].includes(a));
const list = args.filter(a => !a.startsWith('-'));
if (bad.length || list.some(a => !isAddr(a)) || (!list.length && !args.includes('--thresholds'))) {
  console.error('用法: node src/cli/devcheck.mjs <合约> [<合约> …] [--json]  |  node src/cli/devcheck.mjs --thresholds'); process.exit(1);
}
if (!list.length) {
  const t = thresholds();
  if (JSON_OUT) console.log(JSON.stringify(t));
  else console.log(`本机门槛（${t.created?.slice(0, 10) || ''} 随机生成，删掉 data/thresholds.json 会重新生成）：\n  付费按份铸币进度 ≥ ${t.paidProgress}%\n  自己发交易铸造的钱包 ≥ ${t.minSenders} 个（钱没留在合约里时 ≥ ${t.minSendersDrained} 个）`);
  process.exit(0);
}
let blocked = false;
for (const ca of list) {
  let r;
  try { r = await devCheck(ca); } catch (e) { r = { contract: ca.toLowerCase(), verdict: '拦', block: ['检查没跑完（' + String(e.message || e).slice(0, 80) + '），按不通过处理'], warn: [], info: {} }; }
  if (r.block.length) blocked = true;
  if (JSON_OUT) { console.log(JSON.stringify(r)); continue; }
  console.log(`${r.info.name || r.contract}  →  ${r.verdict}`);
  for (const b of r.block) console.log('  ✗ 拦：' + b);
  for (const w of r.warn) console.log('  ! ' + w);
  console.log('  ' + JSON.stringify(r.info));
}
process.exit(blocked ? 2 : 0);
