#!/usr/bin/env node
// 工作量证明求解（有的 Agent 项目要求先算出一个 nonce 才能 mint）。只在本机算，不联网、不发交易。
// 用法:
//   node src/cli/pow.mjs --hash sha256|keccak256 --prefix 0x<字节> --bits <前导零比特数> [--mode abi|text] [--workers N]
//     abi  （默认）: hash(prefix 字节 ‖ nonce 作为 32 字节大端整数)，常见于 abi.encodePacked(..., uint256 nonce)
//     text        : hash(UTF-8(prefix 文本 + 十进制 nonce))
//   输出 JSON：{ nonce, zeros, hash, seconds }
// prefix 怎么拼要看合约源码（例如 workPrefix(wallet) 之类的只读函数通常直接给出）；先用 --bits 较小的值试一下对不对。
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import os from 'node:os';

const zeros = h => { let n = 0; for (const b of h) { if (b === 0) { n += 8; continue; } return n + Math.clz32(b) - 24; } return n; };

if (isMainThread) {
  const a = process.argv.slice(2), opt = n => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : null; };
  const hash = opt('hash') || 'sha256', prefix = opt('prefix'), bits = Number(opt('bits')), mode = opt('mode') || 'abi';
  const n = Math.max(1, Math.min(Number(opt('workers')) || os.cpus().length, 64));
  if (!['sha256', 'keccak256'].includes(hash) || !prefix || !(bits > 0 && bits <= 40) || !['abi', 'text'].includes(mode) || (mode === 'abi' && !/^0x([0-9a-fA-F]{2})*$/.test(prefix))) {
    console.error('用法: node src/cli/pow.mjs --hash sha256|keccak256 --prefix 0x… --bits N [--mode abi|text] [--workers N]'); process.exit(1);
  }
  const t0 = Date.now(), ws = [];
  for (let i = 0; i < n; i++) {
    const w = new Worker(new URL(import.meta.url), { workerData: { hash, prefix, bits, mode, start: i, step: n } });
    w.on('message', m => { console.log(JSON.stringify({ ...m, seconds: (Date.now() - t0) / 1000 })); ws.forEach(x => x.terminate()); });
    ws.push(w);
  }
} else {
  const { hash, prefix, bits, mode, start, step } = workerData;
  let keccak = null;
  if (hash === 'keccak256') keccak = (await import('@noble/hashes/sha3')).keccak_256;
  const H = buf => keccak ? Buffer.from(keccak(buf)) : createHash('sha256').update(buf).digest();
  if (mode === 'abi') {
    const buf = Buffer.concat([Buffer.from(prefix.slice(2), 'hex'), Buffer.alloc(32)]), off = buf.length - 8;
    for (let k = BigInt(start); ; k += BigInt(step)) {
      buf.writeBigUInt64BE(k, off);
      const h = H(buf); const z = zeros(h);
      if (z >= bits) { parentPort.postMessage({ nonce: k.toString(), zeros: z, hash: '0x' + h.toString('hex') }); break; }
    }
  } else {
    for (let k = start; ; k += step) {
      const h = H(Buffer.from(prefix + k, 'utf8')); const z = zeros(h);
      if (z >= bits) { parentPort.postMessage({ nonce: String(k), zeros: z, hash: '0x' + h.toString('hex') }); break; }
    }
  }
}
