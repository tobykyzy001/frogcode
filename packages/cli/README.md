# @frogcode/cli

FrogCode 命令行工具 — 与 LLM 单轮对话、回放执行轨迹、查看配置。

## 安装

```bash
# 在 monorepo 根目录
pnpm install
pnpm build

# 全局 link（可选，让 frogcode 命令直接可用）
cd packages/cli
pnpm link --global
```

不 link 也能用：`node packages/cli/dist/index.mjs <command>`

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `OPENAI_API_KEY` | OpenAI / OpenAI 兼容服务的 API Key | 必填（用 openai provider 时） |
| `ANTHROPIC_API_KEY` | Anthropic API Key | 必填（用 anthropic provider 时） |
| `FROGCODE_PROVIDER` | 默认 provider：`openai` / `anthropic` | `openai` |
| `FROGCODE_MODEL` | 默认模型名 | `gpt-4o-mini` |
| `FROGCODE_BASE_URL` | 自定义 API base URL（OpenAI 兼容 gateway、代理等） | provider 官方 endpoint |

优先级：命令行参数 > 环境变量 > 默认值。

## 命令

### `frogcode chat <prompt>`

单轮对话，默认流式输出 + Token 统计。

```bash
# 基本用法（用默认 provider/model）
frogcode chat "你好"

# 切换模型
frogcode chat "写一个快排" --model gpt-4o

# 切换到 Anthropic
frogcode chat "你好" --provider anthropic --model claude-3-5-sonnet

# 用本地 OpenAI 兼容 gateway
$env:FROGCODE_BASE_URL = "http://your-gateway/v1"
$env:OPENAI_API_KEY = "sk-..."
frogcode chat "你好" --model GLM-5.2

# 临时覆盖 base URL
frogcode chat "你好" --base-url https://api.openai.com/v1

# 非流式模式（走完整 PRAO 循环，不走 provider.stream）
frogcode chat "你好" --no-stream
```

**选项：**

| 选项 | 说明 |
|------|------|
| `--provider <name>` | `openai` 或 `anthropic` |
| `--model <name>` | 模型名 |
| `--base-url <url>` | 自定义 API base URL |
| `--no-stream` | 关闭流式输出，使用 `agent.run()` 走 PRAO 循环 |

**输出示例（流式）：**

```
$ frogcode chat "说一个笑话"

为什么程序员喜欢黑暗？因为光会引来 bug。
────────────────────────────
Tokens: 87 (prompt: 12, completion: 75)
```

**错误处理：**

API Key 缺失、429 限流、网络错误等会以人类可读格式展示，退出码 1：

```
❌ 未设置 OPENAI_API_KEY 环境变量
⏳ 请求频率限制，重试中... (等待 5s)
🌐 网络错误: connection refused
```

### `frogcode trace [session-id]`

回放 EventStore 中的 StepRecord。

```bash
# 列出所有 session（按时间倒序）
frogcode trace

# 回放指定 session
frogcode trace cli-chat
```

**输出示例：**

```
[1] perceive ─ 234ms
    input:  "你好"
    output: "你好！我是AI助手..."
[2] reason   ─ 567ms
    input:  "你好！我是AI助手..."
    output: {"action":"respond","done":true}
[3] act      ─ 1ms
    ...
[4] observe  ─ 12ms
    ...
────────────────────────────
Total steps: 4
Total time:  814ms
Breakdown:
  perceive:  234ms (28.7%)
  reason:    567ms (69.7%)
  act:         1ms (0.1%)
  observe:    12ms (1.5%)
```

Session 文件存储在 `.frogcode/events/<agent-id>.jsonl`，每行一个 JSON 序列化的 StepRecord。

### `frogcode config`

显示当前配置。

```bash
frogcode config
```

**输出示例：**

```
FrogCode Configuration
────────────────────────
Provider:  openai
Model:     gpt-4o-mini
API Key:   ✓ (OPENAI_API_KEY)
Base URL:  http://your-gateway/v1
Events:    .frogcode/events/
```

`✓` 表示 API Key 已设置，`✗` 表示未设置（不显示 key 的值）。

### `frogcode --help`

显示所有命令。

## OpenAI 兼容 Gateway 场景

FrogCode 支持任何 OpenAI 兼容 API（vLLM、ollama、本地 gateway、Cloudflare AI Gateway 等）：

```bash
# 设置一次
$env:FROGCODE_BASE_URL = "http://your-gateway/v1"
$env:OPENAI_API_KEY = "your-key"

# 之后切换模型只需改 --model
frogcode chat "你好" --model GLM-5.2
frogcode chat "你好" --model MiniMax-M3
frogcode chat "你好" --model DeepSeek-V4-Pro
```

**注意：** 部分 OpenAI 兼容服务不返回 `usage` 字段（token 统计）。这种情况下：
- 流式输出末尾显示 `Tokens: (usage unavailable)`
- 非流式模式 token 统计为 0
- 不影响内容输出

## 退出码

| 退出码 | 含义 |
|--------|------|
| 0 | 成功 |
| 1 | 错误（API Key 缺失、请求失败、文件不存在等） |

## 限制（Phase 2.5）

当前是**最小可用版本**，有以下限制（后续 Phase 会补齐）：

- **单轮对话**：每次 `chat` 都是新 Agent，无记忆（Phase 4 记忆系统）
- **无工具执行**：EchoActHandler 占位，不能调用工具（Phase 3 工具系统）
- **无配置文件**：只用环境变量 + 命令行参数（Phase 8 配置系统）
- **非交互式**：`frogcode chat "prompt"` 直接传参，无 REPL（后续迭代）
