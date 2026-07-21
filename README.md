# FrogCode

> 可观测、可恢复、可编排的 AI Agent 执行框架

让开发者能像写普通代码一样构建可靠的 Agent 应用。

## 核心设计哲学

- **确定性优先**：相同输入 → 相同执行路径（可回放）
- **渐进增强**：从最小可用起步，复杂场景逐步解锁
- **模型无关**：不绑定任何 LLM 厂商

## 当前状态

| Phase | 内容 | 状态 |
|-------|------|------|
| Phase 1 | 核心运行时（PRAO 循环、状态机、事件溯源） | ✅ M1 完成 |
| Phase 2 | LLM 网关（OpenAI/Anthropic、流式、Token 预算、Schema 校验） | ✅ M2 完成 |
| Phase 2.5 | 最小 CLI（chat / trace / config 命令） | ✅ M2.5 完成 |
| Phase 3 | 工具系统（ToolDefinition、Registry、Permission、ForkSandbox、4 个内置工具） | ✅ M3 完成 |
| Phase 4+ | 记忆、规划、编排、Web 界面 | 🚧 规划中 |

## 快速开始

### 安装

```bash
git clone <repo-url> frogcode
cd frogcode
pnpm install
pnpm build
```

要求：Node.js 20+、pnpm 9+。

### 使用 CLI

```bash
# 全局 link（可选）
cd packages/cli
pnpm link --global

# 设置 API Key
$env:OPENAI_API_KEY = "sk-..."   # Windows PowerShell
# export OPENAI_API_KEY="sk-..."  # bash/zsh

# 单轮对话（默认流式输出）
frogcode chat "你好"

# 切换模型
frogcode chat "写一个快排" --model gpt-4o

# 用 OpenAI 兼容 gateway（本地 LLM、vLLM、ollama 等）
$env:FROGCODE_BASE_URL = "http://your-gateway/v1"
frogcode chat "你好" --model GLM-5.2

# 回放执行轨迹
frogcode trace

# 查看当前配置
frogcode config
```

详见 [`packages/cli/README.md`](packages/cli/README.md)。

### 作为库使用

```ts
import { Agent, createAgentConfig } from "@frogcode/core";
import { OpenAIProvider, createLLMHandlers } from "@frogcode/llm";

const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o-mini",
});

const agent = new Agent({
  id: "my-agent",
  config: createAgentConfig({ name: "my-agent" }),
  handlers: createLLMHandlers(provider, { model: "gpt-4o-mini" }),
});

const result = await agent.run({ prompt: "你好" });
console.log(result.steps); // StepRecord[]，每步可回放
```

## 项目结构

```
frogcode/
├── packages/
│   ├── core/            # 核心运行时（PRAO 循环、状态机、事件溯源）
│   ├── llm/             # LLM 网关（Provider 抽象、OpenAI/Anthropic 适配器）
│   ├── cli/             # 命令行工具（chat / trace / config）
│   ├── tools/           # 工具系统（Phase 3，已完成）
│   ├── memory/          # 记忆系统（Phase 4，未开始）
│   ├── planner/         # 规划引擎（Phase 5，未开始）
│   ├── orchestrator/    # 多 Agent 编排（Phase 6，未开始）
│   ├── guardrails/      # 安全护栏（Phase 7，未开始）
│   └── web/             # Web 前端（Phase 6+，未开始）
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.base.json
```

## 核心概念

### PRAO 循环

FrogCode 的 Agent 执行模型基于 **PRAO** 四阶段循环：

| 阶段 | 说明 |
|------|------|
| **P**erceive | 感知输入（用户 prompt、上下文） |
| **R**eason | 推理决策（LLM 调用、决定下一步） |
| **A**ct | 执行动作（调用工具，Phase 3 起） |
| **O**bserve | 观察结果（反馈到下一轮） |

每个阶段产出一个 `StepRecord`，完整记录输入/输出/耗时，可序列化存储和回放。

### 事件溯源

所有 Agent 执行都通过 `EventStore` 持久化为 JSON Lines 文件（`.frogcode/events/<agent-id>.jsonl`），每行一个 `StepRecord`。这让执行过程：

- **可观测**：`frogcode trace <session>` 回放任何一次执行的每一步
- **可恢复**：基于事件日志重建任意时刻的 Agent 状态（Phase 4+）
- **可调试**：定位 LLM 调用、工具执行、决策路径的问题

### Provider 抽象

`LLMProvider` 接口统一了不同 LLM 厂商的调用：

```ts
interface LLMProvider {
  chat(req: ChatRequest, opts?: CallOptions): Promise<ChatResponse>;
  stream(req: ChatRequest, opts?: CallOptions): AsyncIterable<ChatChunk>;
  embed(text: string, opts?: CallOptions): Promise<EmbedResponse>;
}
```

切换模型只需改配置，业务代码不动。支持 OpenAI、Anthropic、以及任何 OpenAI 兼容服务（vLLM、ollama、本地 gateway 等）。

## 开发

```bash
pnpm install          # 安装依赖
pnpm build            # 构建所有包（turbo）
pnpm test             # 运行所有测试
pnpm lint             # Biome 检查

# 单包操作
pnpm --filter @frogcode/core build
pnpm --filter @frogcode/llm test
pnpm --filter @frogcode/cli lint
```

### 技术栈

| 维度 | 选择 |
|------|------|
| 语言 | TypeScript（strict） |
| 运行时 | Node.js 20+ |
| 包管理 | pnpm 9（workspace） |
| 构建 | tsup（ESM + CJS 双输出） |
| 测试 | Vitest |
| Lint | Biome |
| Monorepo | Turborepo |
| Schema 校验 | Zod + Ajv |

## 路线规划

完整路线见 `ROADMAP.md`（项目内部规划文档，不公开）。

| 里程碑 | 内容 | 状态 |
|--------|------|------|
| M1 | Phase 1 核心运行时 | ✅ |
| M2 | Phase 2 LLM 网关 | ✅ |
| M2.5 | Phase 2.5 最小 CLI | ✅ |
| M3 | Phase 3 工具系统 | 🚧 |
| M4 | Phase 4 记忆系统 | 🚧 |
| M5 | Phase 5 规划引擎 | 🚧 |
| M6 | Phase 6 多 Agent 编排 | 🚧 |
| M7 | Phase 7 安全护栏 | 🚧 |
| M8 | Phase 8 完整 SDK + Web 前端 | 🚧 |

## License

Apache-2.0
