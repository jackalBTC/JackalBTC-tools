#!/usr/bin/env node
// 安装向导：检查环境 → 生成 config/config.json → 选择推特数据源并保存 Key → 准备 data/ 目录 → 提示下一步。
// Key 只保存在你自己电脑的 ~/.config/binance-ai-wallet-tools/secrets.json（权限 600），不会写进项目目录。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const say = m => console.log(m);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
// 回答排队：提前到达的输入（例如用管道自动安装）不会丢
const lines = [], waiters = [];
rl.on('line', l => { const w = waiters.shift(); w ? w(l) : lines.push(l); });
rl.on('close', () => { while (waiters.length) waiters.shift()(''); });
const nextLine = () => lines.length ? Promise.resolve(lines.shift()) : new Promise(r => waiters.push(r));
let muted = false;
const origWrite = rl._writeToOutput?.bind(rl);
if (origWrite) rl._writeToOutput = s => { if (!muted) origWrite(s); else if (s.includes('\n')) origWrite('\n'); };
const ask = async (q, def = '') => { process.stdout.write(def ? `${q} [${def}] ` : `${q} `); return (await nextLine()).trim() || def; };
const askSecret = async q => { process.stdout.write(q + ' '); muted = true; const a = (await nextLine()).trim(); muted = false; if (!process.stdin.isTTY) process.stdout.write('\n'); return a; };
const yes = async (q, def = 'y') => /^y/i.test(await ask(`${q} (y/n)`, def));
const has = cmd => { try { execFileSync(cmd, ['--version'], { stdio: 'pipe' }); return true; } catch { return false; } };
// 子进程默认不接管键盘输入（否则会吃掉向导后面问题的回答）；需要交互的命令传 interactive=true
const run = (cmd, args, interactive = false) => {
  rl.pause();
  const ok = spawnSync(cmd, args, { stdio: [interactive ? 'inherit' : 'ignore', 'inherit', 'inherit'], cwd: ROOT }).status === 0;
  rl.resume();
  return ok;
};

say('\n=== 币安 AI 钱包工具 安装向导 ===\n');

// 1. Node 与依赖
if (Number(process.versions.node.split('.')[0]) < 20) { say(`❌ Node ${process.versions.node} 太旧，请先安装 Node 20 或以上：https://nodejs.org`); process.exit(1); }
say(`✅ Node ${process.versions.node}`);
if (!fs.existsSync(path.join(ROOT, 'node_modules/@noble/hashes'))) { say('安装依赖…'); if (!run('npm', ['install'])) { say('❌ npm install 失败'); process.exit(1); } }
say('✅ 依赖已安装');

// 2. 币安 AI 钱包 CLI（baw）
if (!has('baw')) {
  say('\n需要币安 AI 钱包命令行工具 baw（币安官方发布的 npm 包 @binance/agentic-wallet）。');
  if (await yes('现在用 npm 全局安装？')) run('npm', ['install', '-g', '@binance/agentic-wallet']);
}
has('baw') ? say('✅ baw 已安装') : say('⚠️  baw 还没装好，之后手动运行：npm install -g @binance/agentic-wallet');

// 3. 币安官方 skill（给 Claude Code 用）
const sk = n => fs.existsSync(path.join(ROOT, '.claude/skills', n)) || fs.existsSync(path.join(ROOT, '.agents/skills', n));
const need = ['binance-agentic-wallet', 'query-token-audit', 'query-token-info'].filter(n => !sk(n));
if (need.length) {
  say(`\n还需要币安官方的 skill：${need.join('、')}（来自 github.com/binance/binance-skills-hub）。`);
  if (await yes('现在安装到本项目？')) for (const n of need) run('npx', ['-y', 'skills', 'add', 'binance/binance-skills-hub', '--skill', n], true);
}

// 3b. 把本项目的 skill 复制一份到 .agents/skills/（Codex 等工具从这里读）
{
  const src = path.join(ROOT, '.claude/skills/binance-ai-wallet-tools'), dst = path.join(ROOT, '.agents/skills/binance-ai-wallet-tools');
  fs.rmSync(dst, { recursive: true, force: true }); fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  say('✅ skill 已同步到 .agents/skills/（给 Codex 等工具用）');
}

// 4. 钱包登录状态
if (has('baw')) {
  let st = {}; try { st = JSON.parse(execFileSync('baw', ['wallet', 'status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()); } catch {}
  if (st?.data?.status === 'CONNECTED') say('✅ AI 钱包已登录');
  else say('\n⚠️  AI 钱包还没登录。请在终端运行 `baw auth signin`，用币安 App 扫码，并在 App 里打开「开发者模式」。');
}

// 5. 配置文件
const cfgFile = path.join(ROOT, 'config/config.json');
const cfg = JSON.parse(fs.readFileSync(fs.existsSync(cfgFile) ? cfgFile : path.join(ROOT, 'config/config.example.json'), 'utf8'));
say('\n--- 推特数据源 ---');
say('1) twitterapi.io —— 第三方 X 数据接口，按条计费（约 $0.15/1000 条），结果原样、稳定。注册：https://twitterapi.io');
say('2) Grok（xAI API）—— 用 Grok 的 x_search 工具搜 X，按调用计费，结果由模型整理。注册：https://console.x.ai');
const p = await ask('选哪个？(1/2)', cfg.radar.provider === 'grok' ? '2' : '1');
cfg.radar.provider = p === '2' ? 'grok' : 'twitterapi';
const { getSecret, saveSecret, SECRETS_FILE } = await import('../src/lib/config.mjs');
const keyName = cfg.radar.provider === 'grok' ? 'xai' : 'twitterapi';
if (getSecret(keyName) && !(await yes('已经有 Key 了，要换一个吗？', 'n'))) say('沿用已有的 Key');
else {
  const k = await askSecret(cfg.radar.provider === 'grok' ? '粘贴 xAI API Key（输入不显示）：' : '粘贴 twitterapi.io API Key（输入不显示）：');
  if (k) { saveSecret(keyName, k); say(`✅ 已保存到 ${SECRETS_FILE.replace(process.env.HOME || '', '~')}（只有你本人可读）`); }
  else say('⚠️  没有输入 Key，雷达暂时不能用，之后可重新运行 npm run setup');
}
if (cfg.radar.provider === 'grok') cfg.radar.grokModel = await ask('Grok 模型', cfg.radar.grokModel || 'grok-4-1-fast');
cfg.radar.intervalMinutes = Number(await ask('雷达每隔几分钟搜一次？', String(cfg.radar.intervalMinutes || 20))) || 20;

say('\n--- 花钱规则 ---');
say('默认只打免费的。开启自动付费后，也只会在「源码已验证 + 有官网或官推」时，按下面的上限付小额费用。');
cfg.spending.allowAutoPaid = await yes('开启小额自动付费？', cfg.spending.allowAutoPaid ? 'y' : 'n');
if (cfg.spending.allowAutoPaid) {
  cfg.spending.maxUnitUsd = Number(await ask('单张最多多少美元？', String(cfg.spending.maxUnitUsd))) || cfg.spending.maxUnitUsd;
  cfg.spending.maxPaidPerProject = Number(await ask('每个项目最多付费几张？', String(cfg.spending.maxPaidPerProject))) || cfg.spending.maxPaidPerProject;
  const daily = (await ask('要不要设「每天最多花多少 BNB」？直接回车 = 不设，填数字 = 设', cfg.spending.maxDailyBnb == null ? '' : String(cfg.spending.maxDailyBnb))).trim();
  cfg.spending.maxDailyBnb = daily && Number(daily) >= 0 ? Number(daily) : null;
}
// Telegram（可选）：手机上收提醒 + 只读查询
say('\n--- Telegram 提醒（可选） ---');
say('配置后，新线索、铸造成功、等你决定、余额不足、钱包掉线都会推到你的 Telegram；机器人只读，不能下单。');
if (await yes('要配置 Telegram 机器人吗？', cfg.telegram?.chatIds?.length ? 'n' : 'n')) {
  say('1) 在 Telegram 里搜 @BotFather，发送 /newbot，按提示起名字，拿到一串 token（形如 123456789:ABC…）。');
  const tok = await askSecret('2) 粘贴机器人 token（输入不显示）：');
  const tgApi = (m, b) => fetch(`https://api.telegram.org/bot${tok}/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}), signal: AbortSignal.timeout(30000) }).then(r => r.json()).catch(() => ({}));
  const me = tok ? await tgApi('getMe') : {};
  if (!me.ok) say('⚠️  token 无效或连不上 Telegram，跳过。之后可重新运行 npm run setup。');
  else {
    saveSecret('telegram', tok);
    say(`✅ 机器人 @${me.result.username} 已保存。`);
    say(`3) 现在用你自己的 Telegram 给 @${me.result.username} 发一条任意消息（比如 /start），我等最多 2 分钟…`);
    let chat = null, offset = 0;
    for (let i = 0; i < 6 && !chat; i++) {
      const u = await tgApi('getUpdates', { offset, timeout: 20 });
      for (const x of u.result || []) { offset = x.update_id + 1; if (x.message?.chat) chat = x.message.chat; }
    }
    if (!chat) say('⚠️  没等到消息，之后重新运行 npm run setup 再绑定。');
    else if (await yes(`绑定这个聊天：${chat.first_name || chat.title || ''}${chat.username ? ' @' + chat.username : ''}（id ${chat.id}）？`)) {
      cfg.telegram = { ...(cfg.telegram || {}), chatIds: [...new Set([...(cfg.telegram?.chatIds || []), chat.id])] };
      await tgApi('getUpdates', { offset });   // 确认掉已读消息
      await tgApi('sendMessage', { chat_id: chat.id, text: '✅ 已绑定。之后的提醒会发到这里。发送 /help 查看可用命令（只读）。' });
      say('✅ 已绑定，Telegram 里应该收到一条确认消息。');
    }
  }
}

fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
say('✅ 已写入 config/config.json');

// 6. 数据目录
const data = path.join(ROOT, 'data');
fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'templates'))) if (!fs.existsSync(path.join(data, f))) fs.copyFileSync(path.join(ROOT, 'templates', f), path.join(data, f));
say('✅ data/ 已准备好');

rl.close();
say(`
=== 完成 ===
接下来：
  1. npm run doctor            检查一遍
  2. npm run dashboard          打开看板 http://127.0.0.1:${cfg.dashboard.port}
  3. npm run radar              启动推特雷达（或 npm run service install 让雷达、看板、Telegram 机器人都在后台一直跑）
  4. 在本目录运行 claude        打开 Claude Code，说「开始盯新项目」
`);
