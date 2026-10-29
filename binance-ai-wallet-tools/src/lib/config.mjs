// 配置、数据目录与密钥读取。所有脚本共用。
// - 配置：config/config.json（不存在时用 config/config.example.json 的默认值）
// - 数据：data/（台账、日志、雷达状态；已在 .gitignore 里，永远不提交）
// - 密钥：环境变量优先，其次 ~/.config/binance-ai-wallet-tools/secrets.json（权限 600）。代码里永不打印密钥。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CONFIG_FILE = path.join(ROOT, 'config/config.json');
const EXAMPLE_FILE = path.join(ROOT, 'config/config.example.json');
export const SECRETS_DIR = path.join(os.homedir(), '.config/binance-ai-wallet-tools');
export const SECRETS_FILE = path.join(SECRETS_DIR, 'secrets.json');

const strip = o => Array.isArray(o) ? o.map(strip) : o && typeof o === 'object'
  ? Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, strip(v)])) : o;
const merge = (a, b) => {
  if (Array.isArray(b) || typeof b !== 'object' || b === null) return b ?? a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in (a || {}) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? merge(a[k], v) : v;
  return out;
};

// 配置写错时直接报错退出，不悄悄回退到默认值（尤其是花钱规则）
function validate(cfg) {
  const errs = [], sp = cfg.spending || {};
  if (typeof sp.allowAutoPaid !== 'boolean') errs.push('spending.allowAutoPaid 必须是 true 或 false（不要加引号）');
  for (const k of ['maxUnitUsd', 'maxPaidPerProject', 'maxDailyBnb', 'gasLikeBnb', 'minBnbForTx'])
    if (typeof sp[k] !== 'number' || !Number.isFinite(sp[k]) || sp[k] < 0) errs.push(`spending.${k} 必须是不小于 0 的数字`);
  if (typeof cfg.alerts?.lowBnb !== 'number') errs.push('alerts.lowBnb 必须是数字');
  if (!['twitterapi', 'grok'].includes(cfg.radar?.provider)) errs.push('radar.provider 只能是 twitterapi 或 grok');
  if (!(cfg.radar?.intervalMinutes >= 5)) errs.push('radar.intervalMinutes 至少 5');
  if (!Array.isArray(cfg.radar?.queries)) errs.push('radar.queries 必须是数组');
  if (cfg.agent && typeof cfg.agent.enabled !== 'boolean') errs.push('agent.enabled 必须是 true 或 false');
  if (cfg.agent?.enabled && (!Array.isArray(cfg.agent.command) || !cfg.agent.command.length || !cfg.agent.command.some(x => String(x).includes('{prompt}')))) errs.push('agent.command 必须是数组，并且包含 {prompt}');
  if (cfg.dashboard?.host && !['127.0.0.1', 'localhost', '::1'].includes(cfg.dashboard.host)) errs.push('dashboard.host 只能是本机地址（127.0.0.1 / localhost）');
  if (errs.length) { console.error('config/config.json 有错：\n  - ' + errs.join('\n  - ')); process.exit(78); }
  return cfg;
}

export function loadConfig() {
  const base = strip(JSON.parse(fs.readFileSync(EXAMPLE_FILE, 'utf8')));
  let user = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { user = strip(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); }
    catch (e) { console.error('config/config.json 不是合法的 JSON：' + e.message); process.exit(78); }
  }
  const cfg = validate(merge(base, user));
  cfg.dataDir = path.resolve(ROOT, cfg.dataDir || 'data');
  return cfg;
}
export const config = loadConfig();
export const DATA = config.dataDir;
export const dataFile = n => path.join(DATA, n);

export function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(dataFile(name), 'utf8')); } catch { return fallback; }
}
export function writeJson(name, value) {   // 先写临时文件再改名，避免写一半被读到
  fs.mkdirSync(DATA, { recursive: true });
  const f = dataFile(name), t = f + '.tmp';
  fs.writeFileSync(t, JSON.stringify(value, null, 1));
  fs.renameSync(t, f);
}
export function tailLines(file, n) {
  try { return fs.readFileSync(path.isAbsolute(file) ? file : dataFile(file), 'utf8').trim().split('\n').filter(Boolean).slice(-n); } catch { return []; }
}

// 密钥：name = 'twitterapi' | 'xai'
const ENV = { twitterapi: 'TWITTERAPI_KEY', xai: 'XAI_API_KEY' };
export function getSecret(name) {
  if (process.env[ENV[name]]) return process.env[ENV[name]].trim();
  try { return String(JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'))[name] || '').trim() || null; } catch { return null; }
}
export function saveSecret(name, value) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(SECRETS_DIR, 0o700);
  let s = {}; try { s = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')); } catch {}
  s[name] = value;
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(s, null, 1), { mode: 0o600 });
  fs.chmodSync(SECRETS_FILE, 0o600);
}
