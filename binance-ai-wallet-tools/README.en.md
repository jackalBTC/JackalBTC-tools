# Binance AI Wallet Tools

[中文](README.md)

A "launch hunting" toolkit that runs on your own computer. It works with the **Binance AI Wallet (Binance Agentic Wallet)** and an AI coding agent (**Claude Code**, **OpenAI Codex**, etc. – see [docs/agents.md](docs/agents.md)), and can also be used by hand without any AI:

- **X radar** – searches X every N minutes for new Binance Agent ID ecosystem projects that come with a website or contract address. Data source: **twitterapi.io** or **Grok (xAI API)**.
- **AI verification** – reads contract source code, cross-checks the official website and X account, simulates calls, and sorts each project into *mint now / ask me / skip*.
- **Guarded minting** – one command reads the price, applies your spending rules, uses Binance's own transaction preview as a gate, then executes.
- **Local dashboard** – holdings and floor prices, projects waiting for your decision, radar leads, updates from official accounts of projects you joined, a review page and a full action log.
- **Telegram bot (optional)** – pushes new leads, successful mints, pending decisions, low BNB and wallet disconnects to your phone; you can query status but it can't place orders.

> ⚠️ This is an automation tool, not financial advice. "Free" NFTs still cost gas and most never get a market. Read [docs/security.md](docs/security.md) first.

## Before you start

1. **Free mints only by default.** Anything that costs money (e.g. paid mints after a free first one) is never paid automatically. To enable it, set `spending.allowAutoPaid` to `true` in `config/config.json` and choose per-unit, per-project and per-day caps (`npm run setup` also asks).
2. **"Free" still costs gas and is not a profit guarantee.** Most free NFTs have no market and may never sell. Don't trade or approve unknown tokens that arrive with a mint. Keep enough BNB for gas (0.03 BNB or more recommended) and only use money you can afford to lose.
3. **These two features are not fully field-tested yet – avoid them for now:**
   - **Grok data source** – written against xAI's official docs but not yet run with a real key. Use **twitterapi.io** first.
   - **Unattended mode** (`agent` in `config.json`) – dispatching, queueing and rate limiting are tested, but no real Claude / Codex has processed a lead end to end yet. Instead, **keep a Claude Code session open** and say "start watching for new projects".
4. **One Binance AI Wallet can only be signed in at one place at a time.** Signing in on the web or in another tool kicks this one out; when the radar log shows `ERR NOTCONNECTED`, run `baw auth signin` again. When Developer Mode expires (`ERR DEVMODE`), turn it on again in the app.

---

## Requirements

| Item | Notes |
|---|---|
| macOS / Linux / Windows (WSL) | macOS works best (built-in background service) |
| [Node.js](https://nodejs.org) 20+ | |
| AI coding agent (optional) | [Claude Code](https://claude.com/claude-code), OpenAI Codex or any tool that reads `AGENTS.md`; the toolkit also works by hand |
| **AI Wallet** in the Binance app | Claim a `.ai` Agent ID, turn on **Developer Mode**, and keep a little BNB for gas |
| Telegram bot (optional) | For phone alerts – create one with @BotFather, see [docs/telegram.en.md](docs/telegram.en.md) |
| X data source key (pick one) | [twitterapi.io](https://twitterapi.io) or [xAI Grok API](https://console.x.ai) – sign-up steps in [docs/providers.md](docs/providers.md) |

## Install in three steps

```bash
git clone https://github.com/jackalBTC/JackalBTC-tools.git && cd JackalBTC-tools/binance-ai-wallet-tools
npm run setup        # wizard: dependencies, Binance CLI + official skills, X data source, API key, spending rules
baw auth signin      # scan with the Binance app to sign in to the AI Wallet (once)
npm run doctor       # self-check – all green means ready
```

External installs `setup` may run (it asks first):
- `npm install -g @binance/agentic-wallet` – Binance's official wallet CLI `baw`
- `npx skills add binance/binance-skills-hub --skill …` – Binance's official skills (`binance-agentic-wallet`, `query-token-audit`, `query-token-info`), installed into this project folder

API keys are stored only in `~/.config/binance-ai-wallet-tools/secrets.json` (mode 600) or the env vars `TWITTERAPI_KEY` / `XAI_API_KEY` – never in the repo.

## Start using it

```bash
npm run service install    # keep the radar and dashboard running in the background (launchd on macOS; pm2 commands elsewhere)
open http://127.0.0.1:8790 # dashboard
claude                     # open Claude Code in this folder
```

Then tell Claude Code:

> start watching for new projects

Claude follows the radar log: free projects that pass verification are minted automatically; anything uncertain goes to the dashboard's "waiting for you" area, and you just reply "mint" or "skip". You can also paste a link or contract address and ask "can I mint this?".

Prefer not to run in the background? Run them by hand: `npm run dashboard`, `npm run radar`.

Alerts on your phone: set up the Telegram bot in `npm run setup` (about 2 minutes), see [docs/telegram.en.md](docs/telegram.en.md). The bot is read-only and only answers your own chat.

Fully unattended (no chat window open): enable `agent` in `config/config.json`; the radar then calls the AI command line you specify for each lead. Read [docs/agents.md](docs/agents.md) first.

## Spending rules

In `spending` of `config/config.json` (`npm run setup` also asks):

| Field | Default | Meaning |
|---|---|---|
| `allowAutoPaid` | `false` | off = free mints only; on = allow small automatic payments |
| `maxUnitUsd` | `3` | Max USD per paid unit |
| `maxPaidPerProject` | `10` | Max paid units per project (cumulative) |
| `maxDailyBnb` | `null` (off) | Optional daily cap on automatic payments, off by default |
| `gasLikeBnb` | `0.0005` | A payment totalling no more than this is treated like gas |
| `minBnbForTx` | `0.003` | No transactions when wallet BNB is below this |

Whatever you configure, automatic payment also requires "verified contract source + an official website or X account", and the preview must show no approvals, no unexpected debits and no risk flags. Projects detected as mass-deployed templates, or blocked by the anti-scam check (`npm run devcheck -- <contract>`), only get their free units.

**Paid share-mints** (launches where you buy shares with BNB and liquidity opens once fully minted) go through `npm run share-mint`: progress ≥ this install's threshold, each wallet ≤ `shareMint.budgetUsd` per project (default $30), mint and token contracts both source-verified, an AI source review recorded in the ledger, anti-scam check not blocked – all wallets join automatically only when all five gates pass, otherwise a brief only. `shareMint.enabled` is `false` by default (evaluate and brief only); USDT-paid ones are always brief-only. See "Paid share-mints" in the top-level README.

**Paid NFTs** (ERC721 / ERC1155) are not paid for automatically – brief only (v0.5.0); set `spending.allowPaidNft` to `true` to allow it.

**Per-wallet P&L**: `npm run pnl` (read-only) computes "balance now + what was sent back to you − the money you put in" per wallet, shown on the dashboard's "P&L" page. If you funded the AI wallet from another address, add it to `config.pnl.ownAddresses`, otherwise that money counts as profit. With several wallets you can also turn on `auto.backfill` (missed-mint backfill, off by default). See [docs/auto.md](docs/auto.md).

## Layout

```
.claude/skills/binance-ai-wallet-tools/  rules for the AI (anti-injection, per-step log, 3-way decision, mint flow)
config/config.example.json               config template (setup creates config/config.json, not committed)
src/radar/                               X radar + two data sources
src/cli/                                 mint (guarded minting), mint-all (mint with each wallet in turn), share-mint (paid share-mints, five gates), screen (contract check), devcheck (paid-project anti-scam check), pow (proof of work), log, doctor
src/lib/rules.mjs                        spending rules and preview checks (unit tests in test/, npm test)
src/lib/sharemint.mjs                    share-mint gates, progress reading, budget (unit-tested)
src/server/                              local read-only dashboard
src/telegram/                            Telegram bot (alerts + read-only queries)
src/auto/                                optional background jobs: Element market watch, approval watch (read-only), cost audit; auto-claim / auto-redeem / auto take-profit (send transactions, off by default, see docs/auto.md)
src/lib/wallets.mjs                      multiple wallets (data/wallets.json, optional; see "Multiple wallets" in the top-level README)
scripts/                                 setup, service (background), check (pre-publish privacy scan), wallet (manage wallets)
data/  logs/                             your ledger and logs (not committed)
docs/                                    data sources, markets, agents, Telegram (zh / en), auto jobs, security model
```

## FAQ

**Is my data uploaded anywhere?** No. The ledger and logs stay in local `data/`; keys stay in `~/.config/binance-ai-wallet-tools/`. Only the radar sends search keywords to the data source you chose (twitterapi.io or xAI).

**The project is on an external drive and the background service won't start?** macOS doesn't let background services read or write external drives by default. Add `node` under System Settings → Privacy & Security → Full Disk Access (`npm run service install` prints the exact path), or move the project into your home folder.

**The wallet keeps disconnecting?** An AI Wallet allows one signed-in session at a time; signing in on the web or in another tool kicks this one out – just run `baw auth signin` again. The radar checks every round: `ERR NOTCONNECTED` when signed out, `ERR DEVMODE` when Developer Mode is off or expires within 48 hours.

**Not receiving Telegram messages?** Run `npm run doctor` and check the Telegram line; make sure you messaged the bot and finished pairing (your id is in `telegram.chatIds` of `config/config.json`); if running in the background, check `npm run service status` lists `telegram`. If `/status` gets a reply, it works. See [docs/telegram.en.md](docs/telegram.en.md).

**How do I show a project's floor price on the dashboard?** See [docs/markets.md](docs/markets.md).

## Contributing

Issues and PRs are welcome. Before committing, run `npm run check` to make sure no wallet address, local path or key slipped in (it scans current files only; use [gitleaks](https://github.com/gitleaks/gitleaks) for git history).

## License

[MIT](LICENSE). Not affiliated with Binance, xAI, twitterapi.io or Anthropic.
