# Changelog

[中文](CHANGELOG.md)

What changed in each version, newest first. To upgrade: `git pull` in the repo, then `cd binance-ai-wallet-tools && npm install`, and restart the background services (`npm run service install`).

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
