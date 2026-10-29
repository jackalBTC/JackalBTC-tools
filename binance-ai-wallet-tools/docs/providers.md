# 推特数据源：twitterapi.io 还是 Grok？

雷达需要一个能搜 X（推特）的接口。两个都支持，在 `config/config.json` 的 `radar.provider` 里选，或者运行 `npm run setup` 按提示选。Key **只保存在你自己电脑上**（`~/.config/binance-ai-wallet-tools/secrets.json`，权限 600），也可以用环境变量。

| | twitterapi.io | Grok（xAI API） |
|---|---|---|
| 是什么 | 第三方 X 数据接口，直接返回推文原文 | xAI 官方 API，让 Grok 用 `x_search` 工具搜 X，再整理成我们要的格式 |
| 结果 | 原样、稳定、可分页，带展开后的链接 | 由模型整理，可能漏帖或改写；`t.co` 短链不一定展开 |
| 计费 | 按返回的推文条数，官网标价约 **$0.15 / 1000 条**；每 20 分钟一轮、3 组关键词，实测大约每天 $0.3–0.5 | 按模型 token + 工具调用计费，具体看 xAI 官网价格页；查询组越多越贵 |
| 适合 | 想要稳定、便宜、结果可复核 | 已经有 xAI 账号和额度，或者想让模型帮着筛 |
| 配置名 | `"provider": "twitterapi"` | `"provider": "grok"`，模型填 `radar.grokModel` |
| 环境变量 | `TWITTERAPI_KEY` | `XAI_API_KEY` |

> 价格会变，以两家官网为准。

## 注册 twitterapi.io

1. 打开 <https://twitterapi.io>，用邮箱或 Google 账号注册登录。
2. 进入控制台（Dashboard），复制 **API Key**。
3. 充值：新账号一般有少量免费额度；用完后在控制台充值（支持信用卡 / 加密货币，以官网为准）。
4. 运行 `npm run setup`，选 `1`，粘贴 Key（输入时不显示）。

接口文档：<https://docs.twitterapi.io>。本项目只用到「高级搜索」接口：`GET /twitter/tweet/advanced_search`。

## 注册 xAI（Grok API）

1. 打开 <https://console.x.ai>，登录（可用 X 账号）。
2. 在 **API Keys** 页面创建一个 Key，复制。
3. 在 **Billing** 页面充值或绑定付款方式（API 是单独计费的，和 X Premium / SuperGrok 订阅不是一回事）。
4. 运行 `npm run setup`，选 `2`，粘贴 Key，确认模型名（默认 `grok-4-1-fast`，可换成控制台里能用的其他模型）。

接口文档：<https://docs.x.ai>。本项目调用 `POST https://api.x.ai/v1/responses`，工具 `{"type":"x_search","from_date":"YYYY-MM-DD","allowed_x_handles":[…]}`。

## 用 Grok 时要知道的
- Grok 返回的是「模型整理过的结果」。雷达只把它当线索；合约地址、链接仍然要回到原帖、官网、链上核实（skill 已要求）。
- 一组关键词每轮调用一次；已参与项目的官推每 10 个账号算一次调用。觉得贵就把 `intervalMinutes` 调大、或减少 `queries`。
- 如果某轮返回空，看 `logs/radar.log` 里的 `ERR` 行：常见原因是 Key 无效、余额不足、模型名写错。

## 换数据源
改 `config/config.json` 里的 `radar.provider`，然后重启雷达（`npm run service install` 会重装，或手动重启 `npm run radar`）。两个 Key 可以同时保存，互不影响。
