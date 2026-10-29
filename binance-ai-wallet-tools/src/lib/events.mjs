// 操作日志：只追加到 data/events.jsonl，不改旧记录。每个项目每一步都要写。
import fs from 'node:fs';
import { DATA, dataFile, tailLines } from './config.mjs';

export const STEPS = ['discover', 'verify', 'preview', 'execute', 'confirm', 'skip', 'abort', 'brief', 'approve'];
const SECRETISH = /(private[ _-]?key|seed ?phrase|mnemonic|助记词|私钥|session|api[ _-]?key|secret)\s*[:=]/i;

export function logEvent(project, step, detail, opt = {}) {
  if (!project || !/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(project)) throw new Error('项目 id 只能用字母、数字、- 和 _');
  if (!STEPS.includes(step)) throw new Error('步骤必须是 ' + STEPS.join(' / '));
  if (!detail || !String(detail).trim()) throw new Error('内容不能为空');
  if (opt.tx && !/^0x[0-9a-fA-F]{64}$/.test(opt.tx)) throw new Error('txHash 格式不对，要完整 0x + 64 位');
  if (opt.contract && !/^0x[0-9a-fA-F]{40}$/.test(opt.contract)) throw new Error('合约地址格式不对');
  if (step === 'execute' && !opt.tx) throw new Error('execute 必须带完整 txHash');
  const all = [detail, ...Object.values(opt)].join(' ');
  if (SECRETISH.test(all)) throw new Error('疑似包含敏感信息，拒绝写入');
  const line = { ts: new Date().toISOString(), project: project.toLowerCase(), action: step, detail: String(detail).trim(),
    ...(opt.tx ? { txHash: opt.tx } : {}), ...(opt.contract ? { contract: opt.contract } : {}),
    ...(opt.source ? { source: opt.source } : {}), ...(opt.value ? { value: opt.value } : {}) };
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(dataFile('events.jsonl'), JSON.stringify(line) + '\n');
  return line;
}

export const readEvents = (n = 500) => tailLines('events.jsonl', n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
