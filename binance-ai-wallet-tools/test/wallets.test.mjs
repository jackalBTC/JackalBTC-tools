// 多钱包：wallets.json 校验、baw 环境变量、持仓文件位置、看板合计、Telegram 今日汇总分组。运行：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateWallets, readWallets, envFor, watchFileFor, KEYTAR_OFF } from '../src/lib/wallets.mjs';
import { dataFile } from '../src/lib/config.mjs';
import { mergePositions, mergeOverview, mergeNfts, mergeOutcomes, addCost } from '../src/server/merge.mjs';
import { todaySummary } from '../src/telegram/format.mjs';

const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222', C = '0x3333333333333333333333333333333333333333';
const main = { id: 'main', address: A, main: true };
const w2 = { id: 'w2', address: B, bawDir: '~/.config/x/wallets/w2' };

// ---------- 校验 ----------
test('钱包列表：合法的一主一副 → 通过', () => {
  assert.deepEqual(validateWallets([main, w2]), []);
  assert.deepEqual(validateWallets([main]), []);
});
test('钱包列表：id 格式、重复 id、重复地址、地址格式', () => {
  assert.match(validateWallets([main, { ...w2, id: '../x' }]).join(), /id 只能用/);
  assert.match(validateWallets([main, { ...w2, id: 'MAIN' }]).join(), /重复/);
  assert.match(validateWallets([main, { ...w2, address: A }]).join(), /地址 .* 重复/);
  assert.match(validateWallets([main, { ...w2, address: '0x123' }]).join(), /完整的 0x 地址/);
  assert.match(validateWallets({}).join(), /必须是数组/);
});
test('钱包列表：必须恰好一个主钱包', () => {
  assert.match(validateWallets([w2]).join(), /恰好有一个主钱包.*0 个/);
  assert.match(validateWallets([main, { ...w2, main: true, bawDir: undefined }]).join(), /2 个/);
  assert.match(validateWallets([main, { ...w2, main: 'yes' }]).join(), /main 必须是 true 或 false/);
});
test('钱包列表：副钱包必须有自己的 bawDir，不能重复，不能是 ~/.baw；主钱包不能设 bawDir', () => {
  assert.match(validateWallets([main, { ...w2, bawDir: '' }]).join(), /必须有自己的 bawDir/);
  assert.match(validateWallets([main, w2, { id: 'w3', address: C, bawDir: w2.bawDir + '/' }]).join(), /bawDir 和别的钱包重复/);
  assert.match(validateWallets([main, { ...w2, bawDir: '~/.baw' }]).join(), /默认目录/);
  assert.match(validateWallets([{ ...main, bawDir: '~/x' }, w2]).join(), /主钱包.*不要设 bawDir/);
  assert.match(validateWallets([main, { ...w2, allowPaid: 'true' }]).join(), /allowPaid/);
});
test('读钱包列表：文件不存在 → 只有主钱包；写错 → 报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallets-'));
  const L = readWallets(path.join(dir, 'none.json'));
  assert.equal(L.length, 1); assert.equal(L[0].main, true); assert.equal(L[0].implicit, true);
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify([w2]));
  assert.throws(() => readWallets(path.join(dir, 'bad.json')), /主钱包/);
  fs.writeFileSync(path.join(dir, 'empty.json'), '[]');
  assert.throws(() => readWallets(path.join(dir, 'empty.json')), /空的/);
  fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify([main, w2]));
  assert.deepEqual(readWallets(path.join(dir, 'ok.json')).map(w => w.id), ['main', 'w2']);
  fs.rmSync(dir, { recursive: true });
});

// ---------- 环境变量 / 持仓文件 ----------
test('baw 环境：主钱包去掉外面残留的会话设置；副钱包用自己的目录 + 不用钥匙串', () => {
  const base = { PATH: '/bin', BINANCE_BAW_DIR: '/tmp/leftover', NODE_OPTIONS: '--foo' };
  const m = envFor(main, base);
  assert.equal(m.PATH, '/bin'); assert.ok(!('BINANCE_BAW_DIR' in m)); assert.ok(!('NODE_OPTIONS' in m));
  const s = envFor(w2, base);
  assert.equal(s.BINANCE_BAW_DIR, path.join(os.homedir(), '.config/x/wallets/w2'));
  assert.equal(s.NODE_OPTIONS, '--import=' + pathToFileURL(KEYTAR_OFF).href);
  assert.match(s.NODE_OPTIONS, /^--import=file:\/\/\S+\/keytar-off\.mjs$/);   // 文件 URL 里没有空格，NODE_OPTIONS 不会被拆开
  assert.equal(base.BINANCE_BAW_DIR, '/tmp/leftover');   // 不改传进来的对象
});
test('持仓文件：主钱包 data/watch.json，副钱包 data/wallets/<id>/watch.json', () => {
  assert.equal(watchFileFor(main), dataFile('watch.json'));
  assert.equal(watchFileFor(w2), dataFile('wallets/w2/watch.json'));
});

// ---------- 看板合计 ----------
test('合计持仓：同一合约张数、市值、成本相加；不同合约分开', () => {
  const a = [{ id: 'x', contract: C, held: 2, value: 10, cost: { BNB: 0.01 }, heldByRarity: { R: 1 } }, { id: 't', kind: 'token', contract: A, held: 5, value: null, cost: null }];
  const b = [{ id: 'x', contract: C.toUpperCase().replace('0X', '0x'), held: 1, value: null, cost: { BNB: 0.02, USDT: 3 }, heldByRarity: { R: 2, SR: 1 } }];
  const m = mergePositions([a, b, undefined]);
  assert.equal(m.length, 2);
  const x = m.find(p => p.id === 'x');
  assert.equal(x.held, 3); assert.equal(x.value, 10);
  assert.deepEqual(x.cost, { BNB: 0.03, USDT: 3 }); assert.deepEqual(x.heldByRarity, { R: 3, SR: 1 });
  assert.equal(a[0].held, 2); assert.deepEqual(a[0].heldByRarity, { R: 1 });   // 不改原数据
  assert.deepEqual(addCost(null, null), null);
});
test('合计余额：同一代币相加；有钱包没登录就写出是哪个', () => {
  const o = mergeOverview([
    { walletId: 'main', status: 'CONNECTED', tokens: [{ symbol: 'BNB', address: '0x0', balance: 1, price: 600, value: 600 }], lowBnb: 0.02 },
    { walletId: 'w2', status: 'UNCONNECTED', tokens: [{ symbol: 'BNB', address: '0x0', balance: 0.5, price: 600, value: 300 }], tokensError: '未登录' },
  ]);
  assert.equal(o.walletId, 'all'); assert.equal(o.wallet, null); assert.equal(o.lowBnb, 0.02);
  assert.deepEqual(o.tokens, [{ symbol: 'BNB', address: '0x0', balance: 1.5, price: 600, value: 900 }]);
  assert.equal(o.status, 'w2 UNCONNECTED'); assert.match(o.tokensError, /w2：未登录/);
  assert.equal(mergeOverview([{ walletId: 'a', status: 'CONNECTED', tokens: [] }]).status, 'CONNECTED');
});
test('合计 NFT / 复盘：同一编号只留一条（谁持有算谁），复盘张数和成本相加', () => {
  const n = mergeNfts([[{ contract: C, items: [{ id: 1, owned: false }, { id: 2, owned: true }] }], [{ contract: C, items: [{ id: 1, owned: true }] }]]);
  assert.equal(n.length, 1); assert.deepEqual(n[0].items.map(i => [i.id, i.owned]), [[1, true], [2, true]]);
  const r = mergeOutcomes([[{ contract: C, held: 1, cost: { BNB: 0.01 }, value: null }], [{ contract: C, held: null, cost: null, value: 5 }]]);
  assert.equal(r[0].held, 1); assert.deepEqual(r[0].cost, { BNB: 0.01 }); assert.equal(r[0].value, 5);
});

// ---------- Telegram /today ----------
test('今日汇总：多钱包按钱包分组，没写钱包的算主钱包；单钱包保持原样', () => {
  const now = new Date('2026-10-29T12:00:00'), ok = (project, wallet, ts = '2026-10-29T03:00:00') => ({ action: 'confirm', project, detail: 'status=0x1', ts, ...(wallet ? { wallet } : {}) });
  const multi = todaySummary([ok('a'), ok('a', 'w2'), ok('b', 'w2'), ok('c', 'w2', '2026-10-28T03:00:00')], now, 'main');
  assert.match(multi, /^📅 今天成功铸造 3 笔、2 个项目（2 个钱包）/);
  assert.match(multi, /【main】1 笔、1 个项目\n· a ×1/);
  assert.match(multi, /【w2】2 笔、2 个项目\n· a ×1\n· b ×1/);
  const single = todaySummary([ok('a'), ok('a')], now);
  assert.equal(single, '📅 今天成功铸造 2 笔、1 个项目\n· a ×2');
  assert.equal(todaySummary([ok('a', 'w2'), ok('b', 'w2')], now), '📅 今天成功铸造 2 笔、2 个项目\n· a ×1\n· b ×1');   // 今天只有一个钱包打了：不分组
});
