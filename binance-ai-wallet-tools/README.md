# 币安 AI 钱包工具 · Binance AI Wallet Tools

[English](README.en.md)

一个跑在你自己电脑上的「链上打新」工具，配合 **币安 AI 钱包（Binance Agentic Wallet）** 和一个 AI 编程助手（**Claude Code**、**OpenAI Codex** 等，见 [docs/agents.md](docs/agents.md)）使用，也可以不用 AI、自己手动操作：

- **推特雷达**：每隔 N 分钟搜一轮 X，找带官网 / 合约地址的 Binance Agent ID 生态新项目。数据源可选 **twitterapi.io** 或 **Grok（xAI API）**。
- **AI 核验**：读合约源码、核对官网和官推、模拟调用，按质量分成「直接打 / 待你确认 / 跳过」。
- **安全铸造**：一个命令自动读价格、套用你的花钱规则、用币安官方预演把关，再执行。
- **本地看板**：持仓与地板价、待你确认的项目、雷达线索、已参与项目的官推动态、复盘、完整操作日志。
- **Telegram 机器人（可选）**：新线索、铸造成功、等你决定、余额不足、钱包掉线推到手机；可以查状态，但不能下单。

> ⚠️ 这是自动化工具，不是投资建议。「免费」NFT 也要花 gas，大多没有市场。请先读 [docs/security.md](docs/security.md)。

## 使用前请先知道

1. **默认只打免费的。** 要花钱的部分（首张免费后的续铸等）默认不会自动付；想开，自己在 `config/config.json` 里把 `spending.allowAutoPaid` 改成 `true`，并设好单张、每个项目、每天的上限（`npm run setup` 也会问）。
2. **「免费」也要花 gas，而且不保证赚钱。** 大多数免费 NFT 没有交易市场，可能一直卖不掉；附赠的陌生代币不要去交易或授权。钱包里放够 gas（建议 0.03 BNB 以上），亏得起再用。
3. **这两项还没经过完整实测，建议先别用：**
   - **Grok 数据源**：接口按 xAI 官方文档写的，但还没用真实 Key 跑过。先用 **twitterapi.io**。
   - **无人值守模式**（`config.json` 里的 `agent`）：派发、排队、限流测过，但还没让真的 Claude / Codex 完整处理过一条线索。先**开着 Claude Code 对话用**，说「开始盯新项目」即可。
4. **同一个币安 AI 钱包同一时间只能登录一个地方。** 在网页或别的工具登录会把这边挤掉；雷达日志出现 `ERR NOTCONNECTED` 就重新 `baw auth signin`。开发者模式到期（`ERR DEVMODE`）要在 App 里重新打开。

---

## 需要准备

| 东西 | 说明 |
|---|---|
| macOS / Linux / Windows（WSL） | macOS 体验最好（自带后台托管） |
| [Node.js](https://nodejs.org) 20+ | |
| AI 编程助手（可选） | [Claude Code](https://claude.com/claude-code)、OpenAI Codex 等读 `AGENTS.md` 的工具；不用 AI 也能手动用 |
| 币安 App 里的 **AI 钱包** | 需要领取 `.ai` Agent ID、打开**开发者模式**，钱包里放一点 BNB 当 gas |
| Telegram 机器人（可选） | 想在手机上收提醒的话，用 @BotFather 建一个，见 [docs/telegram.md](docs/telegram.md) |
| 推特数据源 Key（二选一） | [twitterapi.io](https://twitterapi.io) 或 [xAI Grok API](https://console.x.ai)，注册方法见 [docs/providers.md](docs/providers.md) |

## 三步装好

```bash
git clone https://github.com/jackalBTC/JackalBTC-tools.git && cd JackalBTC-tools/binance-ai-wallet-tools
npm run setup        # 向导：装依赖、装币安 CLI 和官方 skill、选推特数据源、保存 Key、设花钱规则
baw auth signin      # 用币安 App 扫码登录 AI 钱包（只需一次）
npm run doctor       # 自检，全绿就可以了
```

`setup` 会用到的外部安装（都会先问你）：
- `npm install -g @binance/agentic-wallet` —— 币安官方钱包命令行 `baw`
- `npx skills add binance/binance-skills-hub --skill …` —— 币安官方 skill（`binance-agentic-wallet`、`query-token-audit`、`query-token-info`），装在本项目目录里

Key 只保存在 `~/.config/binance-ai-wallet-tools/secrets.json`（权限 600）或环境变量 `TWITTERAPI_KEY` / `XAI_API_KEY` 里，不会进仓库。

## 开始用

```bash
npm run service install   # 让雷达和看板在后台一直跑（macOS 用 launchd；其他系统会打印 pm2 命令）
open http://127.0.0.1:8790 # 看板
claude                     # 在本目录打开 Claude Code
```

然后在 Claude Code 里说：

> 开始盯新项目

Claude 会跟踪雷达日志：免费且通过核验的项目自动打，拿不准的放进看板「待你确认」，你回复「打」或「不打」即可。也可以直接贴链接或合约问「这个能打吗」。

不想后台跑，也可以手动：`npm run dashboard`、`npm run radar`。

想在手机上收提醒：`npm run setup` 里配置 Telegram 机器人（约 2 分钟），见 [docs/telegram.md](docs/telegram.md)。机器人只读，只回应你自己的聊天。

想完全无人值守（不开对话窗口）：在 `config/config.json` 打开 `agent`，雷达发现线索后会自动调用你指定的 AI 命令行处理。先读 [docs/agents.md](docs/agents.md)。

## 花钱规则

在 `config/config.json` 的 `spending` 里（`npm run setup` 也会问）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `allowAutoPaid` | `false` | 关 = 只打免费张；开 = 允许小额自动付费 |
| `maxUnitUsd` | `3` | 单张最多多少美元 |
| `maxPaidPerProject` | `10` | 每个项目最多付费几张 |
| `maxDailyBnb` | `0.02` | 每天自动付费合计上限 |
| `gasLikeBnb` | `0.0005` | 一次付费合计不超过这个数时视同 gas |
| `minBnbForTx` | `0.003` | 钱包 BNB 低于这个数不发交易 |

无论怎么配，自动付费都还要求「合约源码已验证 + 有官网或官推」，并且预演里不能有授权、额外扣款或风险提示。被识别为批量模板的项目只拿免费张。

## 目录

```
.claude/skills/binance-ai-wallet-tools/  给 AI 的规则（防投毒、每步日志、决策三档、铸造流程）
config/config.example.json               配置模板（setup 生成 config/config.json，不进 git）
src/radar/                               推特雷达 + 两个数据源
src/cli/                                 mint（安全铸造）、mint-all（多钱包依次铸造）、screen（合约筛查）、pow（工作量证明）、log（日志）、doctor（自检）
src/lib/rules.mjs                        花钱规则与预演检查（test/ 里有单元测试，npm test）
src/server/                              本地只读看板
src/telegram/                            Telegram 机器人（推送 + 只读查询）
src/lib/wallets.mjs                      多钱包（data/wallets.json，可选；见上层 README「多钱包」）
scripts/                                 setup、service（后台托管）、check（发布前隐私检查）、wallet（多钱包管理）
data/  logs/                             你的台账、日志（不进 git）
docs/                                    数据源、市场适配、AI 工具、Telegram（中 / 英）、安全模型
```

## 常见问题

**数据会上传到哪里吗？** 不会。台账、日志都在本地 `data/`；Key 在 `~/.config/binance-ai-wallet-tools/`。只有雷达会把搜索关键词发给你选的数据源（twitterapi.io 或 xAI）。

**项目放在外接硬盘上，后台服务起不来？** macOS 默认不允许后台服务读写外接盘。到「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里加入 `node`（`npm run service install` 会打印具体路径），或者把项目放到用户目录下。

**钱包老是掉线？** 同一个 AI 钱包同一时间只能有一个登录会话，在网页或其他工具登录会把这边挤掉，重新 `baw auth signin` 即可。雷达每轮会检查，掉线时日志里出现 `ERR NOTCONNECTED`；开发者模式关闭或 48 小时内到期会出现 `ERR DEVMODE`。

**Telegram 收不到消息？** 先运行 `npm run doctor` 看 Telegram 一项；确认你给机器人发过消息并完成了绑定（`config/config.json` 的 `telegram.chatIds` 里有你的 id）；后台运行的话看 `npm run service status` 里有没有 `telegram`。给机器人发 `/status` 能回复就说明通了。详见 [docs/telegram.md](docs/telegram.md)。

**怎么让看板显示某个项目的地板价？** 见 [docs/markets.md](docs/markets.md)。

## 贡献

欢迎 Issue 和 PR。提交前请运行 `npm run check`，确认没有带上自己的钱包地址、本机路径或 Key（它只扫当前文件，git 历史请用 [gitleaks](https://github.com/gitleaks/gitleaks)）。

## 许可

[MIT](LICENSE)。与币安（Binance）、xAI、twitterapi.io、Anthropic 均无关联。
