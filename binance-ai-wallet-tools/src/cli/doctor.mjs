#!/usr/bin/env node
// 环境自检：Node、依赖、baw、钱包登录与开发者模式、配置、雷达 Key、数据目录。不打印任何密钥或完整地址。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { config, CONFIG_FILE, DATA, getSecret, ROOT } from '../lib/config.mjs';

const ok = m => console.log('  ✅ ' + m), bad = m => console.log('  ❌ ' + m), warn = m => console.log('  ⚠️  ' + m);
let fails = 0; const fail = m => { bad(m); fails++; };
const mask = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';

console.log('\n环境');
const major = Number(process.versions.node.split('.')[0]);
major >= 20 ? ok(`Node ${process.versions.node}`) : fail(`Node ${process.versions.node}，需要 20 以上`);
fs.existsSync(`${ROOT}/node_modules/@noble/hashes`) ? ok('依赖已安装') : fail('依赖未安装：在项目目录运行 npm install');

console.log('\n币安 AI 钱包（baw）');
let bawOk = false;
try { execFileSync('baw', ['--version'], { stdio: 'pipe' }); bawOk = true; ok('baw 已安装'); } catch { fail('没找到 baw：npm install -g @binance/agentic-wallet'); }
if (bawOk) {
  const { baw, walletAddress } = await import('../lib/chain.mjs');
  const st = await baw(['wallet', 'status']);
  st?.data?.status === 'CONNECTED' ? ok('钱包已登录') : fail(`钱包未登录（${st?.data?.status || st?.error?.message}）：运行 baw auth signin 扫码`);
  if (st?.data?.status === 'CONNECTED') {
    const w = await walletAddress().catch(e => null);
    w ? ok(`BSC 地址 ${mask(w)}`) : fail('读不到 BSC 地址');
    const s = await baw(['wallet', 'settings']);
    const dm = s?.data?.devMode;
    dm?.enabled ? ok(`开发者模式已开（到期 ${dm.expiresAt || '未知'}）`) : fail('开发者模式未开：币安 App → AI 钱包 → 设置 → 开发者模式（合约调用需要）');
    if (w) {
      const { rpc } = await import('../lib/chain.mjs');
      const b = Number(BigInt(await rpc('eth_getBalance', [w, 'latest']))) / 1e18;
      b >= config.alerts.lowBnb ? ok(`BNB ${b.toFixed(4)}`) : warn(`BNB 只有 ${b.toFixed(4)}，低于提醒线 ${config.alerts.lowBnb}`);
    }
  }
}

console.log('\n配置');
fs.existsSync(CONFIG_FILE) ? ok('config/config.json 存在') : warn('还没有 config/config.json，正在使用默认值（运行 npm run setup 生成）');
const sp = config.spending;
ok(`自动付费：${sp.allowAutoPaid ? `开（单张 ≤ $${sp.maxUnitUsd}，每项目 ≤ ${sp.maxPaidPerProject} 张，每天 ≤ ${sp.maxDailyBnb} BNB）` : '关（只打免费）'}`);

console.log('\n推特雷达');
const p = config.radar.provider;
if (p === 'twitterapi') getSecret('twitterapi') ? ok('数据源 twitterapi.io，Key 已配置') : fail('数据源 twitterapi.io，但没有 Key（npm run setup 或环境变量 TWITTERAPI_KEY）');
else if (p === 'grok') getSecret('xai') ? ok(`数据源 Grok（${config.radar.grokModel}），Key 已配置`) : fail('数据源 Grok，但没有 Key（npm run setup 或环境变量 XAI_API_KEY）');
else fail(`未知数据源 ${p}`);

console.log('\nTelegram（可选）');
if (!getSecret('telegram')) ok('未配置（不影响使用；想要手机提醒见 docs/telegram.md）');
else if (!(config.telegram?.chatIds || []).length) warn('有机器人 token，但还没绑定聊天：重新运行 npm run setup');
else ok(`已配置，绑定 ${config.telegram.chatIds.length} 个聊天`);

console.log('\n数据');
fs.mkdirSync(DATA, { recursive: true });
ok(`数据目录 ${DATA.replace(ROOT, '.')}`);

console.log(fails ? `\n有 ${fails} 项需要处理。\n` : '\n全部就绪。\n');
process.exit(fails ? 1 : 0);
