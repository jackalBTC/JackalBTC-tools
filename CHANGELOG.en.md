# Changelog

[中文](CHANGELOG.md)

What changed in each version, newest first. To upgrade: `git pull` in the repo, then `cd binance-ai-wallet-tools && npm install`, and restart the background services (`npm run service install`).

---

## v0.4.2 — 2026-11-01 · Paid share-mints

### New
- **Paid share-mints** (launches where you buy shares of a token with BNB and liquidity opens once fully minted): new command `npm run share-mint -- <projectId> <mintContract> --qty <shares>`. All wallets join automatically **only when all five gates pass**; if any fails it writes a brief and sends nothing:
  - ① progress (shares minted / shares needed to open the pool) ≥ this install's random threshold (the "paid share-mint progress" from v0.4.1). Common view functions are tried automatically (`totalMinted` `sold` `maxShares` `cap` `MAX_SUPPLY` …), or set them with `--sold-fn` / `--cap-fn` / `--cap`; readings that disagree, can't be read or exceed 100% fail;
  - ② each wallet spends at most `shareMint.budgetUsd` per project in total (default $30), BNB converted with Chainlink, earlier spend included; shares are reduced to fit, and a wallet with nothing left is skipped;
  - ③ the mint contract and the token contract are both source-verified on Sourcify;
  - ④ the AI has read the source and recorded a `review` in the ledger (funds stay in the contract, no one can withdraw them at will, the token's mint entry is 0 or locked, LP goes to a burn address) with all four `true`;
  - ⑤ the anti-scam check is not "block"; an unfinished check fails too.
- New `shareMint` config: `enabled` defaults to `false` (evaluate and brief only), `budgetUsd` defaults to `30`. Wrong types exit with an error.
- Each `spend.jsonl` entry now records its USD value at the time (`usd`), which the budget uses.

### Security
- BNB payment only. Paying in USDT needs a token approval, which the automatic flow never grants, so those are always brief-only. No approval, Permit / Permit2, setApprovalForAll or transfer code was added.
- Each wallet still goes through all of `mint`'s checks: session check, simulation at the quoted price, Binance preview (no debit other than the BNB paid to this contract, no approvals, no risk flags), one at a time, every step logged. A daily cap, if set, still applies.
- `mint` / `mint-all` only run in share-mint mode with a pass issued by `share-mint` after all five gates pass (same project and contract, within 30 minutes), so a flag alone can't skip the gates.
- The source-review gate relies on the AI filling it in honestly (code can't tell whether the money can be taken); the rules say never to set `true` without reading the source. The per-wallet, per-project budget remains the real backstop.

---

## v0.4.1 — 2026-11-01 · Scam checks and cost safety

### New
- **Paid-project anti-scam check** (read-only): new command `npm run devcheck -- <contract>` (`--json` for JSON, `--thresholds` to show this install's thresholds; exit code 2 when blocked). `mint` runs it automatically before paying; any "block", or a check that did not finish, drops the paid part and only free units are minted. The AI also includes the verdict in paid-project briefs. Checks:
  - minters are counted by **who sent the mint transaction** (`tx.from`), not by who received tokens, so airdrops / minting on behalf can't inflate it; too few → block, and more are required when the contract holds almost no BNB / USDT;
  - one address minting more than 30% → block (bait: the team self-minting to fake progress);
  - NFT image: empty tokenURI, fake IPFS link, link that doesn't exist, not an image, no image in metadata → block; IPFS is tried on 4 gateways in turn and rate limits / gateway errors / timeouts only warn; the same image already used by another contract → block;
  - the same contract code (minimal proxies and EIP-1967 proxies resolved to their implementation) 3+ times within 24 hours → block. "Seen contracts" are radar candidates from the last 24 hours plus contracts checked in the last 24 hours.
  - Thresholds are **randomised once per install**: paid share-mint progress 60–70%, min senders 20–30 (40–55 when the money is not in the contract), stored in `data/thresholds.json`; delete it to re-roll.
- **Approval watch** (read-only, on by default, `approvalWatch`): every 30 minutes checks each wallet's token approvals; the first run only records a baseline, after that every new approval is pushed as an update, ringing when unlimited or flagged risky by Binance. Alerts only, never revokes.
- **Cost audit** (on by default, `costAudit`): hourly, a collection the spending ledger shows BNB paid for but whose holding cost is empty / 0 gets the cost filled in from the ledger, with a log entry and a notice.

### Improved
- **Token prices**: GeckoTerminal is used alongside DexScreener and the deepest BSC pool from either wins. DexScreener misses Uniswap v4 / PancakeSwap Infinity pools and can badly undervalue some tokens. GeckoTerminal requests are spaced at least 2.2 s apart; if it fails only DexScreener is used and the result is cached for just 30 s. Used by the dashboard and take-profit.
- **Holding value cap**: a token's value is capped at 30% of its pool's liquidity (a thin pool can't absorb the paper value), re-capped after summing wallets; capped cards say so.

### Fixed
- When the BNB price can't be read, take-profit used to fail the whole round; it now uses the last good price (kept in its state file), or skips the round if there is none. A cost that isn't a valid positive number is recomputed every round and the token isn't sold until it is – cost is never taken as 0 / NaN.

### Security
- Everything new is read-only (anti-scam check, pricing, approval watch); the cost audit only edits the local holdings file. No approval, Permit / Permit2, setApprovalForAll or transfer code was added.

---

## v0.4.0 — 2026-11-01 · Market watch and auto jobs

### New
- **Dashboard holdings groups**: "Holdings & market" is now grouped by what is actually going on – **can sell** (a real price exists), **market but no buyers** (Element fills but nobody bids on our token ids, or a market with no listings), **new**, **quiet**, **exited**, **written off**. Exited cards only show total cost, total returned and net P&L (from `realized.json`), or "no sale records".
- **Element market watch** (read-only, on by default): every 30 minutes reads fills, bids and cancels on the Element exchange. When there were ≥3 fills in 3 days with the last ≥ $2, or someone bids ≥ $5 on **token ids we hold**, an "important" update is pushed (once per collection). Only real trades count; "many holders approved a marketplace" is no longer taken as a market.
- **New background service `auto`** (`npm run auto`, `npm run auto:dry` for a dry run): `npm run service install` runs it when anything is enabled. The three jobs below send transactions and are **all off by default**; read `docs/auto.md` first:
  - **Scheduled auto-claim** (`auto.claims.enabled`): claims registered in `data/claims.json` are simulated, then previewed at the set time, and executed only when the preview has no debits, no approvals, no risk flags, needs no App confirmation and delivers the registered token. The token is added to holdings.
  - **Card-to-token redeem** (`auto.redeem.enabled`): when someone on-chain burns a card and receives a token, the same call is replayed for your cards. Zero approvals, zero payment, only this wallet's own cards; the preview may only take those cards and must deliver the token.
  - **Auto take-profit** (`auto.takeProfit.enabled`): at 3x sell the cost basis, at 10 / 30 / 50 / 100 / 150 / 200x sell 20% of what is left, after the 10x stage a fall back to 3x sells half. Per token: `hold: true` (never auto-sell), `sellOnce: 0.5` (sell that share once), `firstTp`, `ladder`, `back3: false`. Only sells tokens in your holdings, only into BNB, never buys; when Binance requires confirmation in the App (error 30003001) you get a ringing alert to confirm.
- **Flap Agent new-market alerts** (radar option `radar.flap.enabled`, off by default): pushed as "🦋 Flap Agent new market" with sound, with quote token, taxes, max per wallet and a short verdict. Names carrying web code or instructions are hidden.
- Token cards show how much take-profit sold, what came back and the remaining cost.

### Improved
- On-chain log queries are split by `rpc.logsMaxRange` and halve automatically when the RPC says the range or result is too large; some RPCs allow only 5000 blocks, so lower it when you switch RPC.

### Security
- The auto jobs contain no approval, Permit / Permit2, setApprovalForAll or transfer code at all; every transaction is `eth_call`-simulated and `baw`-previewed first, shares the mint lock, re-checks the wallet session and logs every step.
- A malformed switch for the auto jobs (e.g. `"true"` in quotes) exits with an error.

---

## v0.3.3 — 2026-10-31 · Only what costs money

### Improved
- **Free mints are no longer pushed one by one**: free projects can produce hundreds of mints a day and drown out what matters. Instead a silent summary goes out every night at 21:00 (Beijing time): what was minted today, realized P&L and holdings. Set `telegram.freeMints: true` to get every one.
- Successful paid mints are still pushed, with transaction link and cost.
- Alerts are now loud or silent: waiting for you, paid project briefs, wallet signed out, low BNB, Developer Mode and "important" project updates ring; everything else is silent.
- Projects marked `quiet: true` in the ledger are not pushed event by event.
- Alerts show the project's real name instead of its internal id.

### New
- **Paid project brief**: `PAID` lines in the radar log (unit price, number of minters, whether an Agent ID is required, whether the contract is an upgradeable proxy, scam-check verdict, separated by `｜`) are pushed as "💸 paid project · waiting for you", with sound.
- New commands `/holdings` (holdings and value) and `/pnl` (realized P&L), read from the local dashboard; plain Chinese words also work: 余额, 持仓, 战绩, 今天, 指令.
- Messages older than 2 minutes (queued while the bot was restarting) are ignored.

---

## v0.3.2 — 2026-10-30 · Small fix

### Improved
- The dashboard wallet drop-down refreshes every 30 s: after renaming a wallet (`label` in `wallets.json`) or adding one, it shows up without reloading the page.

---

## v0.3.1 — 2026-10-30 · Mint stats

### Improved
- The "minted today" card at the top of the dashboard now also shows **yesterday** (projects / transactions) and the **running total** since the first mint, with the start date. Hover to see which projects were minted today and yesterday.
- Only successful on-chain mints count; a transaction logged twice counts once; failed ones are excluded.

---

## v0.3.0 — 2026-10-30 · Multiple wallets

### Added
- **Batch minting across wallets**: keep several Binance AI wallets (different accounts) signed in at once; after the main wallet mints a project, the next wallets follow automatically.
  - `npm run wallet add <name>` signs in and registers a secondary wallet (QR scan); `wallet list` / `wallet status` to check; `wallet login <name>` to re-scan when a session expires.
  - `npm run mint-all <project-id> <contract> <qty>`: main wallet first, then each secondary wallet with a random 20–60 s gap. If the main wallet only failed because its own quota is used up, the others still follow; any other failure (preview rejected, contract problem) stops the batch.
  - `mint` gains `--wallet <name>` to mint with one specific wallet.
- **Dashboard wallet switcher**: a header drop-down shows "all wallets combined" or a single wallet; holdings, balances, collection, P&L and review all follow it.
- **Radar** also checks secondary wallets each round: signed out, Developer Mode expiring, low BNB (at most one alert per issue every 2 hours).
- **Telegram**: `/status` per wallet; `/today` counts projects and groups by wallet when more than one minted; mint messages say which wallet minted.

### Safety
- Every mint checks "the signed-in session is this wallet" at the start, before the preview and before executing; on a mismatch it stops.
- Secondary wallets are **free-only** by default; they pay only if the wallet entry has `allowPaid: true`.
- Per-contract paid caps are counted per wallet.
- Why sign-in works this way, where secondary sessions are stored and the trade-off: see the README section "Multiple wallets".

### Changed
- **The daily spending cap is now optional and off by default** (`spending.maxDailyBnb` is `null`). Only the per-unit price and per-project count limits apply. Put a number there if you want a daily cap; the AI asks whether you want one the first time it sets things up.

---

## v0.2.0 — 2026-10-29 · P&L and token holdings

### Added
- **Dashboard P&L card**: realized P&L (sales recorded in `data/realized.json`) plus unrealized P&L on holdings; several sales of one project are merged into one row; money spent on things that have no market price yet is listed separately and not counted.
- **Token holdings**: tokens you paid for (token mints, launch sales, etc.) appear under "Holdings & market": balance read on-chain; once DexScreener sees a pool they show price, value and P&L, before that "not launched".
- **Telegram mint messages show the cost**: paid mints show "amount paid + gas", free ones show the gas, computed from the on-chain transaction.

### Improved
- Dashboard: recomputed as soon as the holdings file changes and the page refreshes every minute, no manual reload needed.
- Mint: the price fallback understands more patterns (`priceFor(address)`, `publicPrice()`), so fewer mints are blocked for "no readable price".
- Radar:
  - posts whose contracts all belong to projects you already joined are skipped (no more flood of people showing off their mints);
  - projects marked "watching / waiting for you" alert again when they reappear;
  - referral-code whitelist spam ("I'm joining … whitelist … Code: XX-XXXX") is filtered out.

---

## v0.1.0 — 2026-10-29 · First release

- **X (Twitter) radar**: periodically searches X for Agent ID / free-mint leads, extracts only text, links and contract addresses and never executes anything; data source twitterapi.io or Grok.
- **Unified mint**: read the price → apply the spending rules → Binance AI wallet preview check → execute → log, spending ledger, holdings. Free mints run automatically once the preview passes; paid ones need you to enable them, a verified source, an official site or X account, and stay within per-unit and per-project limits.
- **Local dashboard**: assets, holdings & market, radar, official updates, collection, project ledger, review, activity log.
- **Telegram bot (optional)**: pushes mint results, decisions waiting for you, project updates, wallet signed out / low BNB alerts; read-only commands. The bot cannot place orders or spend.
- **Instructions for AI agents** (AGENTS.md / CLAUDE.md / skill file): Claude Code, Codex and other agents follow the same rules.
- Full Chinese and English docs, security notes, and a privacy check that keeps personal information out of the repo.
