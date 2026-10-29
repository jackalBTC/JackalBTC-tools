#!/usr/bin/env node
// 让雷达和看板在后台一直跑（崩了自动重启，开机登录后自动启动）。
//   node scripts/service.mjs install     安装并启动
//   node scripts/service.mjs uninstall   停止并移除
//   node scripts/service.mjs status      查看状态
// macOS 用系统自带的 launchd；其他系统打印 pm2 命令（npm install -g pm2）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGS = path.join(ROOT, 'logs');
const NODE = process.execPath;
const JOBS = [
  { name: 'radar', script: 'src/radar/radar.mjs', log: 'radar.log' },
  { name: 'dashboard', script: 'src/server/server.mjs', log: 'dashboard.log' },
];
const cmd = process.argv[2] || 'status';
const xml = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const run = (c, a) => { try { execFileSync(c, a, { stdio: 'pipe' }); return { ok: true }; } catch (e) { return { ok: false, msg: (String(e.stderr || '') + String(e.stdout || '')).trim() || e.message }; } };
const sh = (c, a) => { try { return execFileSync(c, a, { stdio: 'pipe' }).toString(); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } };
fs.mkdirSync(LOGS, { recursive: true });

if (process.platform !== 'darwin') {
  const pm = JOBS.map(j => `pm2 start "${NODE}" --name binance-ai-wallet-tools-${j.name} --cwd "${ROOT}" --output "${LOGS}/${j.log}" --error "${LOGS}/${j.log}" -- ${j.script}`);
  console.log(cmd === 'install' ? `非 macOS 系统请用 pm2：\n  npm install -g pm2\n  ${pm.join('\n  ')}\n  pm2 save && pm2 startup` :
    cmd === 'uninstall' ? JOBS.map(j => `pm2 delete binance-ai-wallet-tools-${j.name}`).join('\n') : 'pm2 ls');
  process.exit(0);
}

const LA = path.join(os.homedir(), 'Library/LaunchAgents');
const uid = process.getuid();
const label = j => `com.binance-ai-wallet-tools.${j.name}`;
const plist = j => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label(j))}</string>
  <key>ProgramArguments</key><array><string>${xml(NODE)}</string><string>${xml(path.join(ROOT, j.script))}</string></array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(LOGS, j.log))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(LOGS, j.log))}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(path.dirname(NODE))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>${xml(os.homedir())}</string>
  </dict>
</dict></plist>
`;

if (cmd === 'install') {
  fs.mkdirSync(LA, { recursive: true });
  for (const j of JOBS) {
    const f = path.join(LA, label(j) + '.plist');
    sh('launchctl', ['bootout', `gui/${uid}/${label(j)}`]);
    fs.writeFileSync(f, plist(j));
    const r = run('launchctl', ['bootstrap', `gui/${uid}`, f]);
    console.log(r.ok ? `已安装 ${label(j)}，日志 logs/${j.log}` : `❌ ${label(j)} 启动失败：${r.msg}`);
  }
  if (ROOT.startsWith('/Volumes/')) console.log(`\n⚠️  项目放在外接硬盘（${ROOT.split('/').slice(0, 3).join('/')}）上。macOS 默认不允许后台服务读写外接盘，
   需要在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里加入：${NODE}
   加好后再运行一次 npm run service install。或者把项目挪到用户目录下就不需要这一步。`);
  console.log('\n几秒后运行 npm run service status 确认状态。');
} else if (cmd === 'uninstall') {
  for (const j of JOBS) { sh('launchctl', ['bootout', `gui/${uid}/${label(j)}`]); fs.rmSync(path.join(LA, label(j) + '.plist'), { force: true }); console.log(`已移除 ${label(j)}`); }
} else {
  for (const j of JOBS) {
    const out = sh('launchctl', ['print', `gui/${uid}/${label(j)}`]);
    const state = (out.match(/^\s*state = (.+)$/m) || [])[1] || '未安装';
    const exit = (out.match(/last exit code = (.+)$/m) || [])[1] || '';
    console.log(`${j.name.padEnd(10)} ${state}${exit && exit !== '(never exited)' ? '  上次退出：' + exit : ''}`);
  }
}
