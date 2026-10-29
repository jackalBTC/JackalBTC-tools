# 用哪个 AI 当「大脑」

工具本身（雷达、看板、`mint.mjs`、`screen.mjs`、`doctor`）是普通的 Node 命令行程序，**人也能直接用**：看看板上的雷达线索，自己运行 `node src/cli/mint.mjs …`。花钱规则和预演把关写在代码里，不依赖 AI。

让 AI 来「读线索 → 核验 → 决定打不打」有两种方式：

## 方式一：开着对话（默认）

在项目目录打开你的 AI 工具，说「开始盯新项目」。

| 工具 | 读哪个说明文件 | 能不能自动盯日志 |
|---|---|---|
| Claude Code | `CLAUDE.md`（引用 `AGENTS.md`）+ `.claude/skills/` | 能（Monitor 工具） |
| OpenAI Codex | `AGENTS.md` + `.agents/skills/` | 看工具版本；不能的话用方式二 |
| 其他读 `AGENTS.md` 的工具 | `AGENTS.md` | 同上 |

> 各工具对 `AGENTS.md`、skill 目录的支持情况会变，以各自文档为准。不支持 skill 的工具，`AGENTS.md` 已经告诉它去读 `.claude/skills/binance-ai-wallet-tools/SKILL.md`。

## 方式二：雷达自动调用 AI（无人值守）

在 `config/config.json` 里打开 `agent`：

```json
"agent": {
  "enabled": true,
  "command": ["claude", "-p", "{prompt}"],
  "kinds": ["new", "hot"],
  "maxPerHour": 6,
  "timeoutMinutes": 15
}
```

雷达每发现一条线索，就运行一次 `command`（`{prompt}` 换成任务说明），AI 处理完这一条就退出。
- 一次只跑一个，排队执行；每小时最多 `maxPerHour` 次。
- AI 的输出记在 `logs/agent-日期.log`，雷达日志里会有 `AGENT` 行。
- 传给 AI 的只有线索 id、原帖链接和数据文件位置，不把推文正文拼进命令。

### 命令怎么写（示例，具体参数以各工具文档为准）

**Claude Code**（无头模式要预先放行它需要的命令，否则会卡在权限确认上）：
```json
["claude", "-p", "{prompt}",
 "--allowedTools", "Read", "Edit(data/**)", "Write(data/**)",
 "Bash(node src/cli/screen.mjs:*)", "Bash(node src/cli/mint.mjs:*)", "Bash(node src/cli/log.mjs:*)",
 "Bash(baw:*)", "Bash(curl:*)"]
```

**OpenAI Codex**：
```json
["codex", "exec", "{prompt}"]
```
Codex 默认的沙箱可能不允许联网或改文件，需要按它的文档放开「工作目录可写」和「可联网」（`baw`、链上 RPC、雷达都要联网）。

### 打开之前想清楚
- **它会自己花钱**：在你的 `spending` 规则范围内自动铸造。先把 `allowAutoPaid` 关着跑几天，看看它的判断，再决定要不要开。
- **每条线索都消耗 AI 额度**：雷达线索多的时候一小时可能有好几条，`maxPerHour` 是上限。
- **权限放得越宽越危险**：只放行上面列的命令。不要给 `Bash(*)`、`--dangerously-skip-permissions` 这类全开权限——防投毒规则靠模型遵守，权限是最后一道墙。
- 想先试一下：把 `kinds` 设成 `["new"]`、`maxPerHour` 设成 1，盯着 `logs/agent-*.log` 看它怎么处理。
