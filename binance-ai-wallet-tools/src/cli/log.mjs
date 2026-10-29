#!/usr/bin/env node
// 写一条操作日志。
// 用法: node src/cli/log.mjs <项目id> <步骤> "<做了什么、结果是什么>" [--tx 0x…] [--contract 0x…] [--source url] [--value 金额] [--wallet 钱包id]
// 步骤: discover verify preview execute confirm skip abort brief approve
import { logEvent } from '../lib/events.mjs';

const [project, step, detail, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 2) {
  const k = rest[i]?.replace(/^--/, ''), v = rest[i + 1];
  if (!['tx', 'contract', 'source', 'value', 'wallet'].includes(k) || v == null) { console.error('日志未写入：未知参数 ' + rest[i]); process.exit(1); }
  opt[k] = v;
}
try { const l = logEvent(project, step, detail, opt); console.log('已记录', l.ts, l.project, l.action); }
catch (e) { console.error('日志未写入：' + e.message); process.exit(1); }
