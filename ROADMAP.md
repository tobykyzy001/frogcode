# FrogCode - AI Agent 执行框架路线规划

## 项目愿景

构建一个**可观测、可恢复、可编排**的 AI Agent 执行框架，让开发者能像写普通代码一样构建可靠的 Agent 应用。

核心设计哲学：
- **确定性优先**：相同输入 → 相同执行路径（可回放）
- **渐进增强**：MVP 5 分钟跑通，复杂场景逐步解锁
- **模型无关**：不绑定任何 LLM 厂商

---

## 技术选型

| 维度 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript | 全栈统一、类型安全、生态丰富 |
| 运行时 | Node.js 20+ | 流式处理强、工具生态成熟 |
| 包管理 | pnpm | Monorepo 友好 |
| 项目结构 | Monorepo (turborepo) | 核心包 + 插件包隔离 |
| 构建 | tsup | ESM/CJS 双输出 |
| 测试 | Vitest | 快、原生 TS 支持 |
| Lint | Biome | 快、一体化 |
| Schema 校验 | Zod + Ajv | Zod：Schema 即类型，自带运行时校验；Ajv：兼容已有 JSON Schema 导入 |
| Embedding | transformers.js | 本地 ONNX 推理，离线可用，不绑定 LLM 厂商 |

---

## 项目结构（Monorepo）

```
frogcode/
├── packages/
│   ├── core/            # Phase 1: 核心运行时
│   ├── llm/             # Phase 2: LLM 网关
│   ├── tools/           # Phase 3: 工具系统
│   ├── memory/          # Phase 4: 记忆系统
│   ├── planner/         # Phase 5: 规划引擎
│   ├── orchestrator/    # Phase 6: 多 Agent 编排
│   ├── guardrails/      # Phase 7: 安全护栏
│   ├── cli/             # Phase 8: CLI 工具
│   └── web/             # Phase 8: Web 前端界面（对话 + Agent 流程可视化）
├── examples/            # 使用示例
├── docs/                # 文档站
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.base.json
```

---

## Phase 1: 核心运行时 (Agent Runtime)

**目标**：定义 Agent 的基本执行模型，跑通 PRAO 循环

**交付物**：
- [x] P1.1 项目脚手架：Monorepo 结构 + 构建配置 + CI 基础
- [x] P1.2 Agent 生命周期状态机：`idle → running → paused → completed | failed`
- [x] P1.3 执行循环引擎：Perceive → Reason → Act → Observe 循环
- [x] P1.4 消息协议：定义 `Message` / `Step` / `Event` 类型体系
- [x] P1.5 事件溯源：每一步执行产出 `StepRecord`，完整可回放
- [x] P1.6 执行上下文 (`ExecutionContext`)：传递状态、配置、元数据
- [x] P1.7 基础配置系统：`AgentConfig` 定义 agent 行为参数

**核心类型**：
```typescript
interface Agent {
  id: string
  config: AgentConfig
  state: AgentState
  run(input: AgentInput): Promise<AgentOutput>
  pause(): void
  resume(): void
  abort(): void
}

type AgentState = 'idle' | 'running' | 'paused' | 'completed' | 'failed'

interface StepRecord {
  id: string
  agentId: string
  type: 'perceive' | 'reason' | 'act' | 'observe'
  input: unknown
  output: unknown
  timestamp: number
  duration: number
  metadata: Record<string, unknown>
}
```

**验收标准**：
- 单 Agent 能跑通一个硬编码的 PRAO 循环
- 每步产出 `StepRecord`，可序列化存储
- 状态机转换完整，pause/resume 工作正常

---

## Phase 2: LLM 网关 (LLM Gateway)

**目标**：统一 LLM 调用接口，支持多模型、流式、容错

**交付物**：
- [ ] P2.1 Provider 抽象层：`LLMProvider` 接口（chat / stream / embed）
- [ ] P2.2 OpenAI 适配器实现
- [ ] P2.3 Anthropic 适配器实现
- [ ] P2.4 流式响应处理：SSE 解析 + tool_call 逐步提取
- [ ] P2.5 Token 计数与预算管理：输入/输出 token 追踪
- [ ] P2.6 重试与降级策略：指数退避 + fallback provider
- [ ] P2.7 Prompt 模板系统：变量插值 + 条件片段 + 版本管理
- [ ] P2.8 Schema 校验层：Zod/Ajv 双适配器，LLM 输出运行时校验 + 校验失败容错链

**核心类型**：
```typescript
interface LLMProvider {
  chat(req: ChatRequest): Promise<ChatResponse>
  stream(req: ChatRequest): AsyncIterable<ChatChunk>
  embed(text: string): Promise<number[]>
}

interface ChatRequest {
  messages: Message[]
  model: string
  temperature?: number
  maxTokens?: number
  tools?: ToolDefinition[]
}

interface ChatResponse {
  content: string
  toolCalls?: ToolCall[]
  usage: TokenUsage
  model: string
}

// === P2.8 Schema 校验 ===

// 统一校验接口，Zod 和 Ajv 都适配到此接口
interface SchemaValidator {
  validate(input: unknown): ValidationResult
  toJsonSchema(): JSONSchema  // 统一导出给 LLM
}

type ValidationResult =
  | { success: true; data: unknown }
  | { success: false; errors: SchemaError[]; retryable: boolean }

interface SchemaError {
  path: string
  message: string
  expected: string
  received: string
}

// Zod 路径：SDK 用户用 Zod 定义工具，自动推导 TS 类型 + JSON Schema
const fileReadSchema = z.object({
  path: z.string().describe('文件路径'),
  encoding: z.string().optional().default('utf-8'),
})
// z.infer<typeof fileReadSchema> → { path: string; encoding: string }
// zodToJsonSchema(fileReadSchema) → 标准 JSON Schema 传给 LLM

// Ajv 路径：用户已有 JSON Schema（OpenAPI 导入、迁移），直接消费
// Tool.fromJSONSchema({ name: 'dbQuery', inputSchema: existingSchema })
```

**验收标准**：
- 统一接口调用 OpenAI / Anthropic，切换只需改配置
- 流式 tool_call 实时解析，无丢失
- 重试和降级自动触发
- Prompt 模板支持变量插值和条件逻辑
- LLM 返回的 toolCall 参数经过运行时校验，格式错误不导致崩溃
- 校验失败时自动进入容错链：可修正错误反馈给 LLM 重试，不可修正则跳过并记录

---

## Phase 3: 工具系统 (Tool System)

**目标**：声明式工具注册 + 类型安全调用 + 沙箱执行

**交付物**：
- [ ] P3.1 工具定义 schema：`ToolDefinition`（输入/输出 JSON Schema + 描述）
- [ ] P3.2 工具注册表 (`ToolRegistry`)：注册、发现、校验
- [ ] P3.3 工具调用管线：解析 → 校验 → 执行 → 后处理
- [ ] P3.4 内置工具集：文件读写、Shell 执行、HTTP 请求、搜索
- [ ] P3.5 权限模型：工具级 `Permission`（allow / deny / confirm）
- [ ] P3.6 沙箱执行：进程隔离 + 资源限制（超时、内存）
- [ ] P3.7 工具组合：管道式 `toolA | toolB` 和 DAG 式编排

**核心类型**：
```typescript
interface ToolDefinition {
  name: string
  description: string
  inputSchema: JSONSchema
  outputSchema: JSONSchema
  permissions: Permission[]
}

interface ToolRegistry {
  register(tool: ToolDefinition, handler: ToolHandler): void
  resolve(name: string): ToolDefinition | undefined
  execute(name: string, input: unknown, context: ExecutionContext): Promise<ToolResult>
}

type Permission = 'file:read' | 'file:write' | 'shell:execute' | 'network:access' | 'confirm:required'
```

**验收标准**：
- 声明式注册工具，自动生成 JSON Schema 供 LLM 调用
- 权限拦截生效，高风险操作需审批
- 沙箱隔离，工具崩溃不影响 Agent 主进程
- 内置工具集可完成基础文件操作和网络请求

---

## Phase 4: 记忆系统 (Memory)

**目标**：多层级记忆管理，支持上下文窗口优化

**交付物**：
- [ ] P4.0 Embedding 提供者抽象：本地 transformers.js（ONNX 推理）+ API 降级（OpenAI），离线可用，不绑定 LLM 厂商
- [ ] P4.1 短期记忆 (`ShortTermMemory`)：当前对话轮次的消息队列
- [ ] P4.2 工作记忆 (`WorkingMemory`)：Scratchpad，agent 当前推理状态
- [ ] P4.3 上下文窗口管理：自动裁剪策略（滑动窗口 / 摘要 / 关键信息保留）
- [ ] P4.4 长期记忆接口 (`LongTermMemory`)：存储 + 检索抽象
- [ ] P4.5 向量存储适配器：内存 (hnswlib-node) / Redis (RediSearch) / PostgreSQL (pgvector)
- [ ] P4.6 记忆检索策略：相似度 + 时序 + 重要性加权
- [ ] P4.7 记忆管理器 (`MemoryManager`)：统一管理各层记忆的生命周期

**核心类型**：
```typescript
interface MemoryManager {
  shortTerm: ShortTermMemory
  working: WorkingMemory
  longTerm: LongTermMemory

  add(message: Message): Promise<void>
  retrieve(query: string, options?: RetrieveOptions): Promise<MemoryEntry[]>
  summarize(): Promise<string>
  compact(): Promise<void>  // 触发上下文压缩
}

interface RetrieveOptions {
  topK?: number
  minRelevance?: number
  timeRange?: { from: number; to: number }
}

// === P4.0 Embedding 提供者 ===

// 统一接口，本地和 API 都适配到此接口
interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
  readonly dimensions: number
}

// 默认：本地 transformers.js（all-MiniLM-L6-v2，384维，模型仅 23MB，CPU ~50ms/条）
// 离线可用，满足"确定性优先"和"模型无关"原则
class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384
  // 懒加载 ONNX pipeline，首次调用时初始化
}

// 降级：OpenAI API（批量场景或模型不可用时）
class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 1536
}
```

**验收标准**：
- 对话超出 token 预算时自动压缩/摘要
- 长期记忆支持向量检索，命中率 > 80%
- 记忆生命周期正确（短期 → 压缩 → 长期）
- 多种存储后端可切换
- 本地 Embedding 离线可用，不依赖外部 API
- 开发期零配置（内存向量库 + 本地 embedding），生产期切 Redis/pgvector 只改配置

---

## Phase 5: 规划引擎 (Planner)

**目标**：让 Agent 能分解复杂任务并动态调整计划

**交付物**：
- [ ] P5.1 任务分解器 (`TaskDecomposer`)：LLM 驱动的目标拆解
- [ ] P5.2 执行计划 (`ExecutionPlan`)：DAG 表示，支持并行/串行/条件分支
- [ ] P5.3 计划执行器 (`PlanExecutor`)：按 DAG 拓扑顺序执行
- [ ] P5.4 动态重规划：步骤失败时回溯 + 重新分解
- [ ] P5.5 推理策略可插拔：CoT / ReAct / Reflexion 适配器
- [ ] P5.6 计划可视化：DAG 结构序列化（Mermaid / JSON）

**核心类型**：
```typescript
interface ExecutionPlan {
  id: string
  goal: string
  steps: PlanStep[]
  dependencies: Map<string, string[]>  // stepId → 依赖的 stepIds
}

interface PlanStep {
  id: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  agentId?: string
  toolCalls?: ToolCall[]
  retryCount: number
  maxRetries: number
}

interface Planner {
  decompose(goal: string, context: ExecutionContext): Promise<ExecutionPlan>
  replan(plan: ExecutionPlan, failedStep: PlanStep): Promise<ExecutionPlan>
}
```

**验收标准**：
- 复杂目标自动拆解为 3+ 步骤的 DAG
- 并行步骤同时执行，串行步骤按序执行
- 失败步骤触发重规划而非整体失败
- DAG 可导出为 Mermaid 图

---

## Phase 6: 多 Agent 编排 (Orchestrator)

**目标**：多 Agent 协作完成复杂任务

**交付物**：
- [ ] P6.1 Agent 注册表 (`AgentRegistry`)：发现、能力声明
- [ ] P6.2 角色定义 (`AgentRole`)：职责、能力边界、工具权限
- [ ] P6.3 消息总线 (`MessageBus`)：Agent 间通信（发布/订阅 + 点对点）
- [ ] P6.4 编排策略：主从 (Supervisor) / 对等 (Swarm) / 流水线 (Pipeline)
- [ ] P6.5 任务分配器 (`TaskAllocator`)：按能力匹配 Agent + 任务
- [ ] P6.6 冲突解决机制：资源竞争仲裁、决策分歧投票
- [ ] P6.7 全局上下文共享：Agent 间状态同步
- [ ] P6.8 Agent 运行时拓扑 (`AgentTopology`)：基于 MessageBus 事件自动追踪 Agent 父子关系与执行状态，SubAgent 完成后通过 MessageBus 推送完成消息给 Parent（消息推送模式，无需新增 `waiting` 状态）
- [ ] P6.9 SubAgent 重试控制 (`SubAgentController`)：失败/超时 SubAgent 可重试（subagent 粒度），支持改输入重跑，重试历史完整可追溯

**核心类型**：
```typescript
interface Orchestrator {
  agents: AgentRegistry
  bus: MessageBus
  strategy: OrchestrationStrategy

  execute(goal: string): Promise<OrchestrationResult>
}

type OrchestrationStrategy = 'supervisor' | 'swarm' | 'pipeline' | 'custom'

interface AgentRole {
  name: string
  capabilities: string[]
  tools: string[]
  permissions: Permission[]
  maxConcurrentTasks: number
}

interface MessageBus {
  publish(channel: string, message: AgentMessage): void
  subscribe(channel: string, handler: MessageHandler): () => void
  send(from: string, to: string, message: AgentMessage): void
}

// === P6.8 Agent 运行时拓扑 ===
// 基于 MessageBus 事件自动构建，不修改 AgentState 状态机
// SubAgent 完成后推送完成消息给 Parent，Parent 无需轮询
// 拓扑数据供 P8.3 Web 前端消费

interface AgentTopology {
  nodes: TopologyNode[]
  edges: TopologyEdge[]  // parent → child
  snapshot(): TopologySnapshot
}

interface TopologyNode {
  agentId: string
  parentId?: string
  state: AgentState  // 复用现有 5 状态，不新增 waiting
  role?: string
  startedAt: number
  completedAt?: number
}

interface TopologyEdge {
  from: string  // parent agentId
  to: string    // child agentId
  type: 'spawn' | 'message'
}

// === P6.9 SubAgent 重试控制 ===
// 重试粒度：整个 SubAgent（非 PRAO 单步）
// 触发方式：编排器自动重试 / 用户通过 Web UI 手动重试

interface SubAgentController {
  retry(agentId: string, opts?: { input?: AgentInput }): Promise<AgentOutput>
  cancel(agentId: string): void
  getRetryHistory(agentId: string): RetryRecord[]
}

interface RetryRecord {
  agentId: string
  attempt: number
  input: AgentInput
  status: 'running' | 'completed' | 'failed'
  error?: string
  timestamp: number
}
```

**验收标准**：
- 3+ Agent 协作完成单 Agent 无法完成的任务
- 主从模式下 Supervisor 正确分配子任务
- Agent 间消息传递无丢失
- 一个 Agent 崩溃不影响其他 Agent
- Agent 拓扑实时反映父子关系与执行状态，SubAgent 完成后自动推送消息给 Parent
- 失败 SubAgent 可重试，支持修改输入后重跑，重试历史完整可追溯

---

## Phase 7: 安全护栏 (Guardrails)

**目标**：Agent 行为可控、可审计、可干预

**交付物**：
- [ ] P7.1 输入过滤器 (`InputFilter`)：Prompt injection 检测 + 清洗
- [ ] P7.2 输出校验器 (`OutputValidator`)：结构化验证 + 幻觉检测
- [ ] P7.3 资源限制器 (`ResourceLimiter`)：Token / API 调用 / 执行时间上限
- [ ] P7.4 人工审批流 (`HumanApproval`)：高风险操作暂停等待审批
- [ ] P7.5 审计日志 (`AuditLog`)：完整操作记录，不可篡改
- [ ] P7.6 护栏配置 DSL：声明式定义安全策略

**核心类型**：
```typescript
interface Guardrail {
  check(input: AgentInput, context: ExecutionContext): Promise<GuardrailResult>
}

interface GuardrailResult {
  allowed: boolean
  reason?: string
  modified?: AgentInput  // 清洗后的输入
  requiresApproval?: boolean
}

interface ResourceBudget {
  maxTokensPerStep: number
  maxTokensTotal: number
  maxApiCalls: number
  maxExecutionTimeMs: number
  maxRetries: number
}
```

**验收标准**：
- Prompt injection 攻击被拦截率 > 95%
- 超出资源预算自动终止
- 高风险操作（如删除文件）必须人工确认
- 完整审计日志可追溯每一步决策

---

## Phase 8: 开发者体验 (DX)

**目标**：让框架好用、好调试、好集成

**交付物**：
- [ ] P8.1 CLI 工具：`frogcode run / test / debug / trace`
- [ ] P8.2 开发者 SDK：流畅的链式 API
- [ ] P8.3 Web 前端界面（`@frogcode/web`）：对话 + Agent 流程一体化可视化，不只是只读追踪，而是完整交互界面
  - [ ] P8.3a 对话界面：消息流展示、工具调用展开、流式输出、多 Agent 会话切换
  - [ ] P8.3b Agent 流程视图：实时拓扑图（消费 P6.8 `AgentTopology` 数据）、状态高亮、SubAgent 重试/取消操作（对接 P6.9 `SubAgentController`）
  - [ ] P8.3c 执行回放：历史执行流时间轴回放（消费 `EventStore` + `AgentTopology` 快照）
- [ ] P8.4 配置文件：`frogcode.config.ts` 声明式配置
- [ ] P8.5 插件系统：第三方扩展钩子
- [ ] P8.6 示例集：5+ 典型场景完整示例
- [ ] P8.7 文档站：快速开始 + API 参考 + 架构指南

**SDK 设计预览**：
```typescript
import { Agent, tools, llm } from '@frogcode/core'

const agent = Agent.create({
  name: 'coder',
  llm: llm.openai({ model: 'gpt-4o' }),
  tools: [tools.fileSystem(), tools.shell(), tools.search()],
  memory: { type: 'auto', maxTokens: 8000 },
  guardrails: {
    maxTokensPerStep: 2000,
    requireApproval: ['file:delete', 'shell:execute'],
  },
})

const result = await agent.run('重构 auth 模块，将 session 改为 JWT')
```

**验收标准**：
- 5 行代码创建可运行的 Agent
- CLI 能启动/调试/回放 Agent 执行
- Web 前端实时展示对话流 + Agent 拓扑，支持 SubAgent 重试/取消操作
- 文档覆盖所有核心 API

---

## 里程碑时间线

| 里程碑 | 阶段 | 核心能力 | 验收标志 |
|---|---|---|---|
| **M1 - Heartbeat** ✅ | Phase 1 | Agent 能跑通 PRAO 循环 | 单 Agent 完成一次完整交互 |
| **M2 - Think** | Phase 2 | 接入 LLM，Agent 能推理 | Agent 用 LLM 完成推理 + 工具调用 |
| **M3 - Act** | Phase 3 | 工具系统可用 | Agent 调用内置工具完成任务 |
| **M4 - Remember** | Phase 4 | 记忆系统工作 | 长对话不爆 token，长期记忆可检索 |
| **M5 - Plan** | Phase 5 | 规划引擎可用 | 复杂任务自动拆解 + 动态重规划 |
| **M6 - Collaborate** | Phase 6 | 多 Agent 协作 + 可观测 | 3+ Agent 协作 + 拓扑实时可见 + SubAgent 可重试 |
| **M7 - Safe** | Phase 7 | 安全护栏生效 | 攻击拦截 + 资源限制 + 人工审批 |
| **M8 - Ship** | Phase 8 | 开发者可用 | SDK + CLI + Web 界面 + 文档 + 示例齐全 |

> M1 - Heartbeat 已完成于 Phase 1 实现。单 Agent 能跑通 Mock PRAO 循环，每步产出 StepRecord，状态机 pause/resume 正常。

---

## 设计原则（贯穿所有阶段）

1. **事件溯源优先**：每个状态变更都是不可变事件，支持完整回放
2. **类型安全**：所有接口和配置都有 TypeScript 类型定义
3. **可测试性**：每个组件都可独立测试，LLM 调用可 mock
4. **零依赖核心**：`@frogcode/core` 不依赖任何 LLM SDK，由 adapter 引入
5. **配置优于代码**：能用配置解决的就不写代码
6. **渐进复杂度**：简单场景简单用，复杂场景有逃生舱
