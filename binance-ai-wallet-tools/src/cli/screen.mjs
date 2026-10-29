#!/usr/bin/env node
// 只读合约筛查：是否有代码 → Sourcify 是否验证 → 名称 / 总量 / 我的持有 → 从 ABI 找 mint/claim 并用 value=0 模拟 → 列出价格相关的只读函数。
// 不发任何交易。用法: node src/cli/screen.mjs <合约> [<合约> …]
import { rpc, ethCall, sel, word, decodeStr, walletAddress, isAddr } from '../lib/chain.mjs';
import { config } from '../lib/config.mjs';

const list = process.argv.slice(2).filter(isAddr);
if (!list.length) { console.error('用法: node src/cli/screen.mjs <合约地址> [...]'); process.exit(1); }
const W = await walletAddress().catch(() => '0x0000000000000000000000000000000000000001');
const num = h => (h && h.length >= 66 ? Number(BigInt(h.slice(0, 66))) : null);

for (const addr of list) {
  const r = { contract: addr };
  r.hasCode = (await rpc('eth_getCode', [addr, 'latest'])).length > 2;
  let abi = null;
  try {
    const m = await (await fetch(`https://sourcify.dev/server/v2/contract/${config.chainId}/${addr}?fields=abi`, { signal: AbortSignal.timeout(20000) })).json();
    r.verified = m.match || null; abi = m.abi || null;
  } catch { r.verified = null; }
  r.name = decodeStr((await ethCall({ to: addr, data: '0x' + sel('name()') })).ok);
  r.totalSupply = num((await ethCall({ to: addr, data: '0x' + sel('totalSupply()') })).ok);
  r.myBalance = num((await ethCall({ to: addr, data: '0x' + sel('balanceOf(address)') + word(W) })).ok);
  const cands = [];
  if (abi) {
    for (const f of abi.filter(x => x.type === 'function' && /^(mint|claim|freeMint|publicMint|mintFree|freeClaim|mintWithBnb)$/i.test(x.name))) {
      const types = f.inputs.map(i => i.type);
      if (types.some(t => !['uint256', 'uint8', 'uint16', 'uint32', 'address'].includes(t))) { cands.push({ fn: `${f.name}(${types})`, skip: '参数类型复杂，需手动构造' }); continue; }
      cands.push({ fn: `${f.name}(${types.join(',')})`, payable: f.stateMutability === 'payable', data: '0x' + sel(`${f.name}(${types.join(',')})`) + f.inputs.map(i => i.type === 'address' ? word(W) : word(1)).join('') });
    }
    r.readFns = abi.filter(x => x.type === 'function' && ['view', 'pure'].includes(x.stateMutability) && /price|fee|cost|quote|max|limit|per|free|open|active|paused/i.test(x.name) && x.inputs.length <= 2)
      .map(x => `${x.name}(${x.inputs.map(i => i.type)})`);
  } else for (const s of ['mint()', 'mint(uint256)', 'claim()']) cands.push({ fn: s, data: '0x' + sel(s) + (s.includes('uint256') ? word(1) : '') });
  r.tries = [];
  for (const c of cands) {
    if (c.skip) { r.tries.push(c); continue; }
    const x = await ethCall({ from: W, to: addr, data: c.data });
    r.tries.push({ fn: c.fn, payable: c.payable, sim: x.ok !== undefined ? 'value=0 模拟成功' : '回滚：' + x.err });
  }
  console.log(JSON.stringify(r, null, 1));
}
