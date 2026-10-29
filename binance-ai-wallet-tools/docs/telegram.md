# Telegram 机器人（可选）

关掉电脑上的 AI 对话窗口后，也能在手机上收到提醒、查状态。

## 它会做什么
**推送**（在 `config/config.json` 的 `telegram.notify` 里选）：

| 类型 | 什么时候推 |
|---|---|
| `CANDIDATE` / `HOT` | 雷达发现新线索 / 多人在传 |
| `UPDATE` | 已参与项目的官推新帖（默认不推，比较多） |
| `MINT` | 铸造成功（带交易链接） |
| `PENDING` | 有项目等你决定 |
| `ABORT` | 某次铸造被安全检查拦下 |
| `LOWBNB` / `NOTCONNECTED` / `DEVMODE` | BNB 不足 / 钱包掉线 / 开发者模式关闭或快到期 |
| `ERR` | 雷达出错 |

**查询命令**（只读）：`/status` 钱包和余额、`/pending` 等你决定的项目、`/today` 今天铸造了什么、`/radar` 最近的线索、`/settings` 推送设置。

## 它不会做什么
- **不能下单、不能花钱、不能改配置。** 要打 / 不打，还是在 Claude Code 等 AI 助手里说。这样即使机器人 token 或你的 Telegram 账号泄露，别人也动不了钱包。
- **只回应你绑定的聊天。** 别人找到你的机器人发消息，它完全不回。
- 消息按纯文本发，推文里的内容不会变成可点的按钮或格式。

## 设置（约 2 分钟）
1. 在 Telegram 搜 **@BotFather**，发送 `/newbot`，按提示起一个名字和用户名，拿到 token（形如 `123456789:ABC…`）。
2. 运行 `npm run setup`，到「Telegram 提醒」一步选 `y`，粘贴 token。
3. 按提示用你自己的 Telegram 给刚建的机器人发一条消息（比如 `/start`），向导会读到你的聊天 id 并绑定，Telegram 里会收到一条「已绑定」。
4. 运行 `npm run service install`，机器人会和雷达、看板一起在后台跑（或手动 `npm run telegram`）。

token 和其他 Key 一样只存在 `~/.config/binance-ai-wallet-tools/secrets.json`（或环境变量 `TELEGRAM_BOT_TOKEN`），不会进仓库。聊天 id 存在 `config/config.json`（不进 git）。

## 注意
- 推送内容会经过 Telegram 的服务器（包括钱包余额、项目名、交易链接）。介意的话只开 `MINT`、`LOWBNB`、`NOTCONNECTED` 这几类。
- 同一分钟最多推 20 条，超出的会合并成一条「请看看板」。
- 想给多个人发（比如朋友一起看），把对方的聊天 id 加进 `telegram.chatIds`。群聊也可以：把机器人拉进群、在群里发条消息，再运行一次 setup 绑定群。
