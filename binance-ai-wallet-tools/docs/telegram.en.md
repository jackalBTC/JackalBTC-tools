# Telegram bot (optional)

[中文](telegram.md)

Get alerts and check status on your phone even when the AI chat window on your computer is closed.

## What it does
**Push alerts** (choose in `telegram.notify` of `config/config.json`):

| Type | When |
|---|---|
| `NEWS` | Latest updates from projects you joined: Chinese summaries the AI writes after reading official X accounts (`data/news.json`), filtered by `telegram.newsLevels`; by default 重要 (important) / 机会 (opportunity) / 注意 (caution) |
| `CANDIDATE` / `HOT` | The radar found a new lead / several people are sharing it |
| `UPDATE` | Raw posts from official accounts of joined projects (off by default – noisy and mostly replies; `NEWS` summaries are enough) |
| `MINT` | Successful mint (with a transaction link) |
| `PENDING` | A project is waiting for your decision |
| `ABORT` | A mint was stopped by a safety check |
| `LOWBNB` / `NOTCONNECTED` / `DEVMODE` | Low BNB / wallet signed out / Developer Mode off or expiring |
| `ERR` | Radar error |

**Commands** (read-only): `/status` wallet and balance, `/pending` projects waiting for you, `/today` today's mints, `/news` latest updates from joined projects, `/radar` recent leads, `/settings` alert settings.

## What it won't do
- **It can't place orders, spend money or change settings.** To mint or skip, tell your AI agent (Claude Code etc.). Even if the bot token or your Telegram account leaks, nobody can touch the wallet through it.
- **It only answers chats you paired.** Anyone else who finds your bot gets no reply at all.
- Messages are plain text – content from tweets can't turn into buttons or disguised links.

## Setup (about 2 minutes)
1. In Telegram, search **@BotFather**, send `/newbot`, pick a name and username, and copy the token (looks like `123456789:ABC…`).
2. Run `npm run setup`, answer `y` at the "Telegram" step and paste the token.
3. As prompted, send any message (e.g. `/start`) to your new bot from your own Telegram. The wizard reads your chat id and pairs it; you'll get a "paired" message.
4. Run `npm run service install` to keep the bot running in the background with the radar and dashboard (or run `npm run telegram` by hand).

Like the other keys, the token is stored only in `~/.config/binance-ai-wallet-tools/secrets.json` (or env var `TELEGRAM_BOT_TOKEN`) and never enters the repo. Chat ids live in `config/config.json` (not committed).

## Notes
- Alerts pass through Telegram's servers (wallet balance, project names, transaction links, update summaries). If that bothers you, keep only `MINT`, `LOWBNB`, `NOTCONNECTED` in `telegram.notify`.
- At most 20 messages per minute; extra ones are merged into a single "check the dashboard" note.
- On first start the bot only records existing log lines and updates – it doesn't resend history.
- To send to several people (e.g. friends), add their chat ids to `telegram.chatIds`. Groups work too: add the bot to a group, send a message there, then run setup again to pair the group.
- If the token leaks (e.g. pasted into a chat), send `/revoke` to @BotFather for a new one and run `npm run setup` again.
