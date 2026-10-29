#!/usr/bin/env node
// 发布前隐私检查：扫描会被提交到 git 的文件，找出可能泄露个人信息的内容。
//   - 任何不在白名单里的 0x 地址（钱包、交易哈希都算）
//   - 本机路径（/Users/…、/Volumes/…、C:\Users\…）
//   - 邮箱
//   - 疑似 API Key / 私钥 / 助记词
//   注意：只扫当前文件，不扫 git 历史。发布前建议再用 gitleaks（https://github.com/gitleaks/gitleaks）扫一遍历史。
// 有命中就以非 0 退出。用法：npm run check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'logs', '.agents']);
const SKIP_FILES = new Set(['config/config.json', 'package-lock.json']);
// 公开的合约地址（BSC 公共基础设施），允许出现在代码和文档里
const PUBLIC = new Set([
  '0x60b9262456de011f7d15a54cdd8c48baaa8b022f', // Binance Agent ID 注册表
  '0x55d398326f99059ff775485246999027b3197955', // USDT (BSC)
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB
  '0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee', // Chainlink BNB/USD
  '0x17307eab39ab6107e8899845ad3d59bd9653f200a220920489ca2b5937696c31', // ApprovalForAll 事件签名
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', // Transfer 事件签名
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', // EIP-1967 实现合约存储槽
  '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000001',
]);
const RULES = [
  // 同一个字符重复的（如 0x1111…）是测试里的假地址，放行
  ['地址或哈希', /0x[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?(?![0-9a-fA-F])/g, m => !PUBLIC.has(m.toLowerCase()) && !/^0x(.)\1+$/i.test(m)],
  ['本机路径', /(\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|\/Volumes\/[^\s'"`)]+|[A-Z]:\\Users\\[^\s'"`]+)/g, () => true],
  ['邮箱', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, m => !/@(example\.(com|org)|noreply\.|users\.noreply\.github\.com)/.test(m) && !/@[\d.]+$/.test(m) && !/^[^@]+@\d/.test(m)],
  ['疑似密钥', /\b(new1_[0-9a-f]{20,}|xai-[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|[0-9a-fA-F]{64})\b/g, m => !PUBLIC.has('0x' + m.toLowerCase())],
  ['疑似助记词', /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g, m => { const w = m.split(/\s+/); return w.length >= 12 && w.every(x => /^[a-z]+$/.test(x)) && new Set(w).size >= 10 && !/\b(the|and|of|to|is|in|for|with|that|this|you|are|it|on|as|be|or|by|if|not|from|your)\b/.test(m); }],
];

const hits = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name), rel = path.relative(ROOT, p);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !(rel.startsWith('.claude/skills/') && !rel.startsWith('.claude/skills/binance-ai-wallet-tools'))) walk(p); continue; }
    if (SKIP_FILES.has(rel) || rel === 'scripts/check.mjs' || /\.(png|jpg|ico|woff2?)$/.test(e.name)) continue;
    const text = fs.readFileSync(p, 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const [kind, re, keep] of RULES) for (const m of line.matchAll(re)) if (keep(m[0])) hits.push(`${rel}:${i + 1}  [${kind}] ${m[0].slice(0, 70)}`);
    });
  }
})(ROOT);

if (hits.length) { console.log(`发现 ${hits.length} 处可能的个人信息，发布前请处理：\n` + hits.join('\n')); process.exit(1); }
console.log('✅ 没有发现个人信息（地址、本机路径、邮箱、密钥）。');
