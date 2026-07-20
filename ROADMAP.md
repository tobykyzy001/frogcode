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
│   ├── cli/             # Phase 2.5: CLI 工具（渐进式，每个 Phase 迭代增强）
│   └── web/             # Phase 6+: Web 前端界面（多 Agent 拓扑可视化需要 Phase 6）
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
- [x] P1.2 Agent 生命周期状态机：`idle → running → waiting → finished | failed | aborted`
- [x] P1.3 执行循环引擎：Perceive → Reason → Act → Observe 循环
- [x] P1.4 消息协议：定义 `Message` / `StepRecord` / `StepType` 类型体系
- [x] P1.5 事件溯源：每一步执行产出 `StepRecord`，完整可回放
- [x] P1.6 执行上下文 (`ExecutionContext`)：传递状态、配置、元数据
- [x] P1.7 基础配置系统：`AgentConfig` 定义 agent 行为参数

**验收标准**：
- 单 Agent 能跑通一个硬编码的 PRAO 循环
- 每步产出 `StepRecord`，可序列化存储
- 状态机转换完整，pause/resume 工作正常

> ✅ **M1 里程碑完成** — Phase 1 核心运行时已交付（PRAO 循环、状态机、事件溯源、执行上下文、配置系统）

---

## Phase 2: LLM 网关 (LLM Gateway)

**目标**：统一 LLM 调用接口，支持多模型、流式、容错

**交付物**：
- [x] P2.1 Provider 抽象层：`LLMProvider` 接口（chat / stream / embed）
- [x] P2.2 OpenAI 适配器实现
- [x] P2.3 Anthropic 适配器实现
- [x] P2.4 流式响应处理：SSE 解析 + tool_call 逐步提取
- [x] P2.5 Token 计数与预算管理：输入/输出 token 追踪
- [x] P2.6 重试策略：指数退避 + jitter + retryAfter 优先 + abort-aware（fallback provider 经评估不必要：无法保证降级后模型可胜任任务，属伪需求）
- [x] P2.7 Prompt 模板系统：变量插值 + 条件片段（版本管理经评估无明确收益，暂不实现）
- [x] P2.8 Schema 校验层：Zod/Ajv 双适配器，LLM 输出运行时校验 + 校验失败容错链

**验收标准**：
- 统一接口调用 OpenAI / Anthropic，切换只需改配置
- 流式 tool_call 实时解析，无丢失
- 重试和降级自动触发
- Prompt 模板支持变量插值和条件逻辑
- LLM 返回的 toolCall 参数经过运行时校验，格式错误不导致崩溃
- 校验失败时自动进入容错链：可修正错误反馈给 LLM 重试，不可修正则抛 `ValidationExhaustedError` 由状态机决定 `failed`（网络/限流类错误由 RetryExecutor 单独处理，不在容错链范围内）

> ✅ **M2 里程碑完成** — Phase 2 LLM 网关已交付（Provider 抽象层、OpenAI/Anthropic 适配器、SSE 流式、Token 预算、HTTP 重试、Prompt 模板、Schema 校验、PRAO 桥接）

---

## Phase 2.5: 最小 CLI (Minimal CLI)

**目标**：让框架立刻可用，边用边暴露问题，驱动后续 Phase 的优先级

**设计原则**：CLI 不是最后才做的"壳"，而是从现在开始每个 Phase 都迭代的"方向盘"。每个后续 Phase 完成后，CLI 增加对应能力展示。

**交付物**：
- [x] P2.5.1 `packages/cli/` 脚手架：`@frogcode/cli` 包，`bin` 字段注册 `frogcode` 命令
- [x] P2.5.2 `frogcode chat` 命令：单轮对话，接入 `createLLMHandlers(provider)`，流式输出到终端
- [x] P2.5.3 Provider 配置：环境变量 `FROGCODE_PROVIDER`（openai/anthropic）、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`FROGCODE_MODEL`
- [x] P2.5.4 `frogcode trace <session-id>` 命令：从 EventStore 回放 StepRecord，展示 PRAO 每步输入/输出/耗时
- [x] P2.5.5 `frogcode config` 命令：显示当前配置（provider、model、token budget）
- [x] P2.5.6 流式输出：`chat` 命令实时显示 LLM 流式 token（消费 `provider.stream()`）
- [x] P2.5.7 Token 统计显示：每次对话结束后显示 prompt/completion/total tokens
- [x] P2.5.8 错误展示：429 重试、token 超限、校验失败等错误以人类可读格式展示

**验收标准**：
- `pnpm build && pnpm link --global` 后 `frogcode chat "你好"` 能真正调用 LLM 并返回结果
- `frogcode chat --provider anthropic --model claude-3-5-sonnet "你好"` 能切换 Provider
- `frogcode trace` 能展示 PRAO 每一步的 StepRecord
- 流式输出在终端实时显示，不是等全部完成才输出
- 429 错误时终端显示 "重试中..." 并最终成功或报错

> ✅ **M2.5 里程碑完成** — 最小 CLI 可用，框架从"库"变成"工具"（`frogcode chat` 单轮对话 + 流式输出 + Token 统计、`frogcode trace` PRAO 回放、`frogcode config` 配置查看、错误人类可读展示）

**后续 Phase 的 CLI 迭代计划**（非本 Phase 交付，仅规划）：
- Phase 3 完成后：`frogcode chat` 支持 `--tool` 参数，展示工具调用过程
- Phase 4 完成后：`frogcode chat` 支持多轮对话（记忆系统），`--history` 显示上下文
- Phase 5 完成后：`frogcode plan` 命令展示任务分解 DAG
- Phase 6 完成后：`frogcode web` 启动 Web 界面，多 Agent 拓扑可视化
- Phase 7 完成后：`frogcode chat` 高风险操作暂停等待审批

---

## Phase 3: 工具系统 (Tool System)

**目标**：声明式工具注册 + 类型安全调用 + 沙箱执行

**交付物**：
- [ ] P3.1 工具定义 schema：`ToolDefinition`（输入/输出 JSON Schema + 描述，Mastra 模式：inputSchema/outputSchema/execute/permission/timeout）
- [ ] P3.2 工具注册表 (`ToolRegistry`)：注册、发现、校验
- [ ] P3.3 工具调用管线：解析 → 校验 → 权限 → 沙箱执行 → 后处理（含 LLM 多 tool_call 并行调度 + 结构化错误传播 + 可观测 hooks）
- [ ] P3.4 内置工具集：文件读写、Shell 执行、HTTP 请求、本地搜索（grep/glob）；Web 搜索经评估延后——所有稳定 Web 搜索 API（Bing Search API 已于 2025-08-11 停用）均需 API key，违背"不绑定外部服务"原则，HTTP 工具天然覆盖该场景
- [ ] P3.5 权限模型：工具级 `Permission`（allow / deny / confirm），Claude Code 风格 7 层管线 + `canUseTool` 回调统一处理交互/程序化两种模式
- [ ] P3.6 沙箱执行：`child_process.fork` 进程隔离 + 资源限制（默认超时 60s 作为 `ToolDefinition` 一部分提供给 LLM + 内存限制 `--max-old-space-size` + SIGTERM→SIGKILL 级联）

> ⚠️ **范围调整说明**：原 P3.7"工具组合（管道式 + DAG 式编排）"已移到 Phase 5 (Planner) 实现。理由：4 个研究 agent 一致判断——工具子系统应是"可靠执行器"而非"工作流引擎"，DAG 编排属于任务规划范畴，与 Phase 5 `ExecutionPlan` DAG 概念重叠。Phase 3 的"工具组合"重新定义为：LLM 多 tool_call 并行调度 + 结构化错误传播 + 可观测 hooks（已合并到 P3.3）。
>
> SubAgent 进程隔离、git worktree 多 feat 隔离、文件事务/rollback 不在 Phase 3 范围（Phase 3 只有单 agent），归 Phase 6 实现。

**验收标准**：
- 声明式注册工具，自动生成 JSON Schema 供 LLM 调用
- 权限拦截生效，高风险操作需审批
- 沙箱隔离，工具崩溃不影响 Agent 主进程
- 内置工具集可完成基础文件操作和网络请求
- timeout 参数作为 ToolDefinition 一部分提供给 LLM，让 LLM 知道工具调用时间限制
- 权限"don't ask again"持久化为 glob 规则（带过期），跨会话生效

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
- [ ] P5.7 工具组合编排：管道式 `toolA | toolB` 和 DAG 式编排（从 Phase 3 P3.7 移入；工具子系统已提供并行调度+错误传播+hooks，本项聚焦跨工具的确定性编排模式）

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
- [ ] P6.2 角色定义 (`AgentRole`)：职责、能力边界、工具权限、prompt 配置、模型配置、模式声明（`primary` / `subagent`）
- [ ] P6.3 消息总线 (`MessageBus`)：Agent 间通信（发布/订阅 + 点对点）
- [ ] P6.4 编排策略：主从 (Supervisor) / 对等 (Swarm) / 流水线 (Pipeline)
- [ ] P6.5 任务分配器 (`TaskAllocator`)：按能力匹配 Agent + 任务
- [ ] P6.6 冲突解决机制：资源竞争仲裁、决策分歧投票
- [ ] P6.7 全局上下文共享：Agent 间状态同步
- [ ] P6.8 Agent 运行时拓扑 (`AgentTopology`)：基于 MessageBus 事件自动追踪 Agent 父子关系与执行状态，SubAgent 完成后通过 MessageBus 推送完成消息给 Parent（消息推送模式，无需新增 `waiting` 状态）
- [ ] P6.9 SubAgent 重试控制 (`SubAgentController`)：失败/超时 SubAgent 可重试（subagent 粒度），支持改输入重跑，重试历史完整可追溯
- [ ] P6.10 内置 Agent 集：核心内置（`supervisor` + `worker`，代码内置不可删除）+ 官方 `json_agent` 包（可选安装，配置文件形式分发）
- [ ] P6.11 自定义 Agent 机制：配置文件声明式（`frogcode.config.ts` 的 `agents` 字段），支持 prompt/model/tools/permissions 全字段配置 + `file://` URI 加载外部 prompt
- [ ] P6.12 SubAgent 会话续接 (`SessionContinuator`)：成功完成的 subagent 可被再次唤起并复用历史上下文继续新任务（区别于 P6.9 的失败重试），降低 token 消耗与推理时间
  - [ ] P6.12a 会话持久化与恢复：subagent session 完成后进入 `dormant` 态，续接时从 `StepRecord` 序列重建 `ExecutionContext` 与 `WorkingMemory`
  - [ ] P6.12b 续接开关（`continueSubagent` 配置项）：全局开关控制续接能力是否启用，默认开启；关闭时所有 subagent 调用走冷启动，行为与未实现该功能完全一致
  - [ ] P6.12c 单次续接选择：即使全局开关开启，每次调用可显式声明 `continue`（复用上下文）或 `restart`（冷启动重新审视），避免错误结论固化
  - [ ] P6.12d 上下文新鲜度检测：基于文件 hash / mtime 检测代码变更，续接时自动标脏已过期上下文项，agent 按需重读
  - [ ] P6.12e 上下文压缩前置：续接前若 session 接近 token 预算，触发压缩（对接 P4.3；P4.3 未完成时由 subagent 自行实现最小摘要逻辑）
  - [ ] P6.12f 跨 session 因果链追溯：`EventStore` 记录续接关系链，支持跨 session 回放与调试
- [ ] P6.13 SubAgent 进程隔离 (`SubAgentIsolation`)：subagent 走 `child_process.fork` 独立进程，崩溃不影响 parent/sibling（区别于 Phase 3 P3.6 的工具级沙箱，本项是 agent 级进程隔离）
- [ ] P6.14 git worktree 多 feat 隔离 (`WorktreeIsolation`)：不同 agent 在不同 git worktree 修改，天然避免文件冲突，支持并行 feat 开发
- [ ] P6.15 文件事务与 rollback (`FileTransaction`)：工具调用前快照文件状态，失败时回退，多 agent 修改冲突检测（对接 P3.3 工具调用管线的 StepRecord diff 数据基础）

**验收标准**：
- 3+ Agent 协作完成单 Agent 无法完成的任务
- 主从模式下 Supervisor 正确分配子任务
- Agent 间消息传递无丢失
- 一个 Agent 崩溃不影响其他 Agent
- Agent 拓扑实时反映父子关系与执行状态，SubAgent 完成后自动推送消息给 Parent
- 失败 SubAgent 可重试，支持修改输入后重跑，重试历史完整可追溯
- 内置 `supervisor` + `worker` 可直接使用，无需配置即可跑通主从编排
- 官方 `json_agent` 包可按需安装，安装后自动注册到 `AgentRegistry`
- 用户可通过 `frogcode.config.ts` 声明自定义 agent，配置 prompt/model/tools/permissions
- 自定义 agent 的 `description` 字段被注入到编排器工具签名，供 LLM 路由选择
- `prompt` / `promptAppend` 支持 `file://` URI 加载外部文件
- 续接开关（`continueSubagent`）开启时，成功完成的 subagent 可被再次唤起并复用上下文，token 消耗 < 冷启动的 50%
- 续接开关关闭时，所有 subagent 调用走冷启动，行为与未实现该功能完全一致，无副作用
- 单次调用可显式选择 `continue` / `restart`，全局开关开启也不会被强制续接
- 文件变更后续接触发新鲜度失效信号，agent 不会基于过期上下文决策
- 续接链可被 `EventStore` 完整追溯与回放
- SubAgent 进程崩溃不影响 parent 和其他 sibling agent，parent 收到结构化错误可重试或换策略
- 多 agent 并行修改同一文件时，git worktree 隔离生效，无冲突写入
- 工具调用失败时基于快照自动 rollback，多 agent 修改冲突被检测并报警

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

**验收标准**：
- Prompt injection 攻击被拦截率 > 95%
- 超出资源预算自动终止
- 高风险操作（如删除文件）必须人工确认
- 完整审计日志可追溯每一步决策

---

## Phase 8: 开发者体验 (DX) — 打磨与文档

**目标**：让框架好用、好调试、好集成

**交付物**：
- [ ] P8.1 开发者 SDK：流畅的链式 API
- [ ] P8.2 Web 前端界面（`@frogcode/web`）：对话 + Agent 流程一体化可视化，不只是只读追踪，而是完整交互界面
  - [ ] P8.2a 对话界面：消息流展示、工具调用展开、流式输出、多 Agent 会话切换
  - [ ] P8.2b Agent 流程视图：实时拓扑图（消费 P6.8 `AgentTopology` 数据）、状态高亮、SubAgent 重试/取消操作（对接 P6.9 `SubAgentController`）
  - [ ] P8.2c 执行回放：历史执行流时间轴回放（消费 `EventStore` + `AgentTopology` 快照）
- [ ] P8.3 配置文件：`frogcode.config.ts` 声明式配置
- [ ] P8.4 插件系统：第三方扩展钩子
- [ ] P8.5 示例集：5+ 典型场景完整示例
- [ ] P8.6 文档站：快速开始 + API 参考 + 架构指南

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
| **M2 - Think** ✅ | Phase 2 | 接入 LLM，Agent 能推理 | Agent 用 LLM 完成推理 + 工具调用 |
| **M2.5 - Touch** | Phase 2.5 | 最小 CLI 可用 | `frogcode chat` 能调 LLM + `frogcode trace` 能回放 |
| **M3 - Act** | Phase 3 | 工具系统可用 | Agent 调用内置工具完成任务 |
| **M4 - Remember** | Phase 4 | 记忆系统工作 | 长对话不爆 token，长期记忆可检索 |
| **M5 - Plan** | Phase 5 | 规划引擎可用 | 复杂任务自动拆解 + 动态重规划 |
| **M6 - Collaborate** | Phase 6 | 多 Agent 协作 + 可观测 + 可扩展 | 3+ Agent 协作 + 拓扑实时可见 + SubAgent 可重试 + SubAgent 会话续接 + 内置 Supervisor/Worker + 自定义 Agent 声明 |
| **M7 - Safe** | Phase 7 | 安全护栏生效 | 攻击拦截 + 资源限制 + 人工审批 |
| **M8 - Ship** | Phase 8 | 开发者可用 | SDK + CLI + Web 界面 + 文档 + 示例齐全 |

> M1 - Heartbeat 已完成于 Phase 1 实现。单 Agent 能跑通 Mock PRAO 循环，每步产出 StepRecord，状态机转换完整、事件溯源可回放。

---

## 设计原则（贯穿所有阶段）

1. **事件溯源优先**：每个状态变更都是不可变事件，支持完整回放
2. **类型安全**：所有接口和配置都有 TypeScript 类型定义
3. **可测试性**：每个组件都可独立测试，LLM 调用可 mock
4. **零依赖核心**：`@frogcode/core` 不依赖任何 LLM SDK，由 adapter 引入
5. **配置优于代码**：能用配置解决的就不写代码
6. **渐进复杂度**：简单场景简单用，复杂场景有逃生舱
