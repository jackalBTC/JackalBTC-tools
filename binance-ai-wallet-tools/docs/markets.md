# 让看板读到某个项目的市场价格

看板的「持仓与市场」按 `data/watch.json` 里每个系列的 `market` 字段决定怎么显示：

```json
{ "collections": [
  { "id": "demo", "name": "Demo NFT", "contract": "0x…", "ids": [12, 13], "image": "tokenURI",
    "cost": { "BNB": 0.001 },
    "market": { "type": "none" } }
] }
```

| type | 用途 |
|---|---|
| `none` | 还没有市场（默认） |
| `link` | 有外部市场，只放链接：`{ "type": "link", "url": "https://…" }` |
| `listing-scan` | 项目自带链上市场，按 tokenId 逐个读挂单，算地板价、在挂数量、按稀有度的地板价 |

## listing-scan 怎么配

先读市场合约的源码（Sourcify / BscScan），找到「按 tokenId 查挂单」的只读函数，然后：

```json
"market": {
  "type": "listing-scan",
  "contract": "0x市场合约",
  "currency": "USDT",
  "decimals": 18,
  "activeFn": "isActive(uint256)",
  "listingFn": "listings(uint256)",
  "priceWord": 1
}
```

- `activeFn`（可选）：判断这个 tokenId 是否在挂，返回非 0 即在挂。没有的话可以用 `activeWord` 指定挂单返回值里第几个字表示「在挂」。
- `listingFn`：返回挂单信息的函数。
- `priceWord`：价格在返回值里是第几个 32 字节字，从 0 开始数。例如 `listings(uint256)` 返回 `(seller, price, expiry)`，价格就是 `1`。
- `decimals`：计价币小数位，USDT（BSC）和 BNB 都是 18。
- `supplyFn`（可选）：遍历上限，默认 `totalSupply()`。

改完不用重启，看板每 5 分钟后台刷新一次。

## 写一个新的适配器

如果市场不是「按 tokenId 查挂单」的结构（比如求购单簿、官方 HTTP 接口），在 `src/server/markets/index.mjs` 里加一个函数：

```js
async function myMarket(market, collection, ctx) {
  // 读链上或接口……
  return { floor: 1.23, listed: 45, byRarity: { Rare: { floor: 3, listed: 2 } } };
}
export const ADAPTERS = { 'listing-scan': listingScan, 'my-market': myMarket };
```

`ctx.rarityOf(id)` 可以读某个 tokenId 的稀有度（来自 tokenURI 元数据）。欢迎提 PR。
