#!/usr/bin/env node
// 多钱包管理（data/wallets.json）。
// 用法:
//   npm run wallet add <id> [-- --label 名字]   登录一个钱包并记进 wallets.json（第一个记为主钱包，用默认登录 / 钥匙串）
//   npm run wallet login <id>                  已有钱包的会话过期 / 被顶掉时重新扫码（地址必须对得上）
//   npm run wallet list                        列出钱包
//   npm run wallet status                      每个钱包：是否登录、会话是不是它、开发者模式到期时间、BNB 余额
// 副钱包的登录会话存在 ~/.config/binance-ai-wallet-tools/wallets/<id>/session.json（目录 700、文件 600），不走系统钥匙串，
// 原因见 src/lib/wallets.mjs。删除钱包：手动编辑 data/wallets.json，再删掉它的会话目录。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { config } from '../src/lib/config.mjs';
import { baw, rpc, isAddr } from '../src/lib/chain.mjs';
import { WALLETS_FILE, WALLET_DIRS, KEYTAR_OFF, ID_RE, readWallets, validateWallets, envFor, sessionOk, expandHome } from '../src/lib/wallets.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const die = m => { console.error('❌ ' + m); process.exit(1); };
const rawList = () => { try { return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; die('data/wallets.json 读不了：' + e.message); } };
const save = list => {
  const errs = validateWallets(list);
  if (errs.length) die('写入前校验没通过：' + errs.join('；'));
  fs.mkdirSync(path.dirname(WALLETS_FILE), { recursive: true });
  fs.writeFileSync(WALLETS_FILE + '.tmp', JSON.stringify(list, null, 1)); fs.renameSync(WALLETS_FILE + '.tmp', WALLETS_FILE);
};
const bnbOf = async a => { try { return Number(BigInt(await rpc('eth_getBalance', [a, 'latest']))) / 1e18; } catch { return null; } };
// 确认屏蔽钥匙串的钩子在这台机器上真的生效（不生效的话副钱包登录会顶掉主钱包）
const hookWorks = () => new Promise(res => execFile(process.execPath, ['--import=' + pathToFileURL(KEYTAR_OFF).href, '--input-type=module', '-e',
  "try { await import('@github/keytar'); } catch (e) { console.log(e.message); }"], (e, out) => res(String(out).includes('keytar disabled'))));

// 扫码登录（用这个钱包的环境）：signin → 打印链接和配对码 → verify 一直等到确认或超时
async function signin(env, who, retry) {
  const si = await baw(['auth', 'signin'], env);
  if (!si.success) die('baw auth signin 失败：' + (si.error?.message || '未知'));
  if (si.data?.status === 'ALREADY_CONNECTED') { console.log('这个会话已经登录，直接读取地址。'); return; }
  const { urlForWeb, qrCodeId, pairingCode } = si.data || {};
  if (!urlForWeb || !qrCodeId) die('baw auth signin 没有返回登录链接');
  console.log(`\n1. 打开这个链接，用币安 App 扫码（${who}的账号）：\n   ${urlForWeb}\n2. 核对 App 里显示的配对码：${pairingCode}\n3. 在 App 里确认登录。这里会一直等，最多 5 分钟……\n`);
  const v = await baw(['auth', 'verify', '--qrCodeId', qrCodeId], env, 330000);
  if (!v.success) die('登录没完成：' + (v.error?.message || '超时') + '。重新运行 ' + retry);
}
const lockDown = dir => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isFile()) fs.chmodSync(p, 0o600); } };   // 会话文件只给自己读

async function add(id) {
  let label = null;
  const more = rest.slice(1);
  for (let i = 0; i < more.length; i++) if (more[i] === '--label' && more[i + 1]) label = more[++i]; else die('不认识的参数 ' + more[i]);
  if (!ID_RE.test(id || '')) die('用法：npm run wallet add <id>（id 只能用字母、数字、- 和 _）');
  const list = rawList();
  if (validateWallets(list).length) die('data/wallets.json 现在就有错，先修好：' + validateWallets(list).join('；'));
  if (list.some(w => w.id.toLowerCase() === id.toLowerCase())) die(`已经有钱包 ${id}`);
  const isMain = list.length === 0;
  const w = { id, label: label || (isMain ? '主钱包' : id), main: isMain };
  if (!isMain) {
    if (!(await hookWorks())) die('这台机器的 Node 不支持屏蔽钥匙串的钩子（需要 Node 20.6+），为了不顶掉主钱包的登录，停止。');
    const dir = path.join(WALLET_DIRS, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(WALLET_DIRS, 0o700); fs.chmodSync(dir, 0o700);
    w.bawDir = '~/' + path.relative(os.homedir(), dir).split(path.sep).join('/');
  }
  const env = envFor(w);
  console.log(isMain ? `这是第一个钱包，记为主钱包「${id}」（用 baw 默认的登录，存在系统钥匙串里）。` : `副钱包「${id}」的登录会话会存在 ${w.bawDir}/session.json（权限 600）。`);
  await signin(env, isMain ? '主钱包' : '要加的这个钱包', 'npm run wallet add ' + id);
  const st = await baw(['wallet', 'status'], env);
  if (st?.data?.status !== 'CONNECTED') die('登录后状态不是 CONNECTED（' + (st?.data?.status || st?.error?.message) + '），重新运行一次');
  const addrs = (await baw(['wallet', 'address'], env))?.data?.addresses || [];
  const a = addrs.find(x => String(x.binanceChainId) === String(config.chainId));
  if (!a || !isAddr(a.address)) die('读不到这个钱包的地址');
  w.address = a.address;
  if (list.some(x => x.address.toLowerCase() === w.address.toLowerCase())) {
    if (w.bawDir) fs.rmSync(path.join(expandHome(w.bawDir), 'session.json'), { force: true });   // 扫成了已有的账号：丢掉这个会话
    die(`这个账号（${w.address}）已经在 wallets.json 里了：扫码时用的是同一个账号？换另一个账号重新运行。`);
  }
  const ag = await baw(['wallet', 'agent-id'], env);
  if (ag?.data?.claimed && ag.data.handle) w.agentId = String(ag.data.handle);
  if (w.bawDir) lockDown(expandHome(w.bawDir));
  save([...list, w]);
  console.log(`✅ 已添加钱包 ${id}：${w.address}${w.agentId ? `（${w.agentId}）` : ''}${isMain ? '（主）' : '（副钱包，默认只打免费）'}`);
  if (!isMain) {   // 再确认一次主钱包的登录没被顶掉
    const m = list.find(x => x.main), e = m && await sessionOk({ ...m, main: true });
    if (e) console.log('⚠️ 主钱包会话检查没通过：' + e);
  }
}

// 已有钱包的会话过期 / 被顶掉：重新扫码。登录后的地址必须和 wallets.json 里记的一致
async function login(id) {
  let L; try { L = readWallets(); } catch (e) { die(e.message); }
  const w = L.find(x => x.id.toLowerCase() === String(id || '').toLowerCase());
  if (!w) die(`没有这个钱包：${id || '（没写 id）'}。用法：npm run wallet login <id>`);
  if (!w.main) { if (!(await hookWorks())) die('这台机器的 Node 不支持屏蔽钥匙串的钩子（需要 Node 20.6+），停止。'); fs.mkdirSync(expandHome(w.bawDir), { recursive: true, mode: 0o700 }); }
  const before = await sessionOk(w);
  if (!before) { console.log(`钱包 ${w.id} 现在就是登录状态，不用重新登录。`); return; }
  if (/对应的不是/.test(before)) {   // 登录着，但是别的账号
    if (w.main) die(before + '。主钱包的登录在系统钥匙串里，先手动运行 baw auth signout，再重新运行这个命令。');
    fs.rmSync(path.join(expandHome(w.bawDir), 'session.json'), { force: true });
  }
  await signin(envFor(w), `钱包 ${w.id}（${w.address || '主钱包'}）`, 'npm run wallet login ' + w.id);
  const e = await sessionOk(w);
  if (e) {
    if (!w.main) fs.rmSync(path.join(expandHome(w.bawDir), 'session.json'), { force: true });
    die(e + (w.main ? '。主钱包登录成了别的账号，请用正确的账号重新运行。' : '。已丢掉这个会话，请用正确的账号重新运行。'));
  }
  if (!w.main) lockDown(expandHome(w.bawDir));
  console.log(`✅ 钱包 ${w.id} 已重新登录`);
}

async function list() {
  let L; try { L = readWallets(); } catch (e) { die(e.message); }
  if (!fs.existsSync(WALLETS_FILE)) console.log('还没有 data/wallets.json：只用一个主钱包（baw 默认登录）。运行 npm run wallet add <id> 添加。');
  for (const w of L) console.log(`${w.main ? '★' : '·'} ${w.id.padEnd(12)} ${w.address || '（地址从 baw 读）'}  ${w.label || ''}${w.main ? '' : w.allowPaid ? '  允许付费' : '  只打免费'}${w.agentId ? '  ' + w.agentId : ''}`);
}

async function status() {
  let L; try { L = readWallets(); } catch (e) { die(e.message); }
  for (const w of L) {
    const env = envFor(w), e = await sessionOk(w), lines = [];
    lines.push(e ? '❌ ' + e : '✅ 已登录，会话对得上');
    if (!e) {
      const dm = (await baw(['wallet', 'settings'], env))?.data?.devMode;
      if (dm) { const left = dm.expiresAt ? (Date.parse(dm.expiresAt) - Date.now()) / 3600_000 : null; lines.push(`开发者模式：${dm.enabled ? '开' : '关'}${dm.expiresAt ? `，到期 ${dm.expiresAt}${left != null && left < 48 ? '（不到 48 小时，记得续期）' : ''}` : ''}`); }
      const addr = w.address || (await baw(['wallet', 'address'], env))?.data?.addresses?.find(x => String(x.binanceChainId) === String(config.chainId))?.address;
      const b = addr && await bnbOf(addr);
      if (b != null) lines.push(`BNB：${b.toFixed(4)}${b < config.alerts.lowBnb ? '（偏低）' : ''}`);
    }
    console.log(`${w.main ? '★' : '·'} ${w.id}${w.label && w.label !== w.id ? `（${w.label}）` : ''}\n   ` + lines.join('\n   '));
  }
}

if (cmd === 'add') await add(rest[0]);
else if (cmd === 'login') await login(rest[0]);
else if (cmd === 'list') await list();
else if (cmd === 'status') await status();
else { console.log('用法：npm run wallet add <id> [-- --label 名字] | login <id> | list | status'); process.exit(cmd ? 1 : 0); }
