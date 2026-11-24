---
name: tri-model-synergy
description: Gemini (System 2 深度思考) × TypeSafe Jev (System 1 校准判别) × OpenAI Codex CLI (沙盒执行与子智能体) 三模型协同编排与子智能体控制指南。当需要跨模型拆解复杂工程、评估补丁门禁、操控 Codex 会话续接/分叉或选择 Antigravity 四层子智能体原语时使用。
---

# 三模型协同编排与子智能体控制指南

本技能沉淀 **`gemini-codex-jev`** 插件暴露的 5 个 MCP 工具及 Antigravity 原生子智能体控制体系的最佳实践，核心理念为：**“思考、判别、执行”三权分立、各展所长**。

---

## 一、 三模型职责矩阵

| 模型 / 引擎 | 认知定位 | 擅长能力 | 核心工具入口 | 边界红线 |
| :--- | :--- | :--- | :--- | :--- |
| **Gemini 4** | System 2 顶层大脑 | 全局代码库理解、架构规划、复杂推理、跨层统筹 | `enter_plan_mode` / `invoke_subagent` / `run_workflow` / `swarm` | 不把海量 Codex 试错终端日志直接堆进主会话 |
| **TypeSafe Jev** | System 1 判别门控 | 非生成式毫秒级校准概率（`choice` / `noul` / `score` / `box`） | `jev_judge` | **不做代码生成、数学计算或最终安全拍板**；仅作概率证据供代码/人类决策 |
| **OpenAI Codex CLI** | 确定性沙盒执行器 | 文件补丁编辑、命令与单测运行、`multi_agent_v2` 子智能体、Diff 审查 | `codex_exec` / `codex_continue` / `codex_review` | 本机默认避开账号不支持的 `gpt-6.2-sol`，自动优选 `gpt-6.1-sol` 等可用模型 |

---

## 二、 Antigravity 四层原生子智能体控制选型

1. **L1 · Plan-Execute（单线复杂开发）**：高思考模型调研并锁定方案后移交执行模型逐条落盘，异常二次失败即触发 `enter_plan_mode` 回交重规划。
2. **L2 · 点对点 Subagent（上下文隔离闭环）**：对独立模块或跨模型交互（如委派 `tri-model-operator` 驱动 Codex 反复跑单测改 Bug），用 `invoke_subagent`（可选 `Workspace="share"` 或 `"branch"` 隔离文件）并在需要时用 `send_message` 追问、`manage_subagents` 销毁。
3. **L3 · `run_workflow`（确定性批处理流水线）**：当需对数十个文件执行相同提取/审查/修复循环时，写 Python 脚本用 `parallel` / `pipeline` / `agent(prompt, schema)` 做强 JSON Schema 扇出聚合。
4. **L4 · `swarm`（多区并行黑板集群）**：当存在 2 个以上独立子系统需作者与验收员交叉作业时，用 `swarm` 建立共享黑板、`#channel` 分区与 `@name` 门铃唤醒；注意配额开销较高。

---

## 三、 Jev (System One) 提问与门禁规范

### 1. 提问设计黄金法则
- **Judgments from Jev, decisions in code**：问客观事实判断（例如“补丁是否修改了目标函数且单测全过？”），不要问宏观决定（例如“我该不该上线？”）。
- **原子化与避免逻辑“或”**：一个问题只测一件事；可同时满足多项条件的判断请拆成多个独立 `noul`，不要硬塞进单选 `choice`。
- **Noul 默认真值门槛**：
  - `probability > 0.7` → 视为 **Yes（放行/命中）**；
  - `probability < 0.3` → 视为 **No（拦截/未命中）**；
  - `0.3 <= probability <= 0.7` → **不确定区间（`uncertain_escalate`）**，必须升级交给 Gemini 人工精读代码/日志或跑确定性测试来拍板。
- **Choice 与 Box 的空值兜底**：`choice` 和 `box` 永远会选一个答案（没有原生“不存在”状态），因此在同一请求中务必配一个独立 `noul` 询问目标是否存在！
- **图片请求条件**：仅支持静态 PNG（禁止 APNG），单边尺寸 `[280, 1568]` 像素，体积 `<= 16 MiB`；插件自动携带 `TypeSafe-Danger-Zone-Images: true` 与规范 `multipart/form-data`（`request` part 居首）。

### 2. 预设模板快速调用
- **前置任务路由 (`preset: "task_route"`)**：同时评估 `execution_route`（`gemini_direct` / `codex_single` / `codex_subagents` / `review_only`）、`needs_write_sandbox` 与 `needs_visual_evidence`。
- **补丁质量门禁 (`preset: "patch_gate"`)**：同时评估 `goal_satisfied` 与 `has_unverified_risk`。

---

## 四、 Codex CLI 会话控制最佳实践

1. **首轮执行 (`codex_exec`)**：
   - 默认以 `sandbox: "workspace-write"`、`model: "gpt-6.1-sol"` 启动；
   - 多模块并发拆解时设置 `enable_subagents: true` 激活 Codex 原生 `multi_agent_v2`（`explorer` 只读侦察 + `worker` 并行修改）；
   - 担心污染主工作区时设 `worktree: true` 在受管 Git Worktree 中运行。
2. **多轮纠偏与分叉 (`codex_continue`)**：
   - `action: "resume"`：保持原 `thread_id` 上下文继续修 Bug 或补测试，无需重复背景说明；
   - `action: "fork"`：从某个稳定的 `thread_id` 状态分叉出独立分支会话探索第二种实现方案；
   - `action: "queue"`：向仍在运行中的后台线程注入补充指令。
3. **独立代码审查 (`codex_review`)**：
   - 传 `uncommitted: true`（或 `base` / `commit`）即可在独立上下文中审查 Git 变更；
   - **CLI 互斥注意**：Codex CLI 的 `--uncommitted` / `--base` / `--commit` 不可与自定义 `[PROMPT]` 同时使用，插件已内置自动防冲突处理。
4. **运行管控 (`bridge_status`)**：
   - `doctor` 核查 `WindowsApps` 完整版 `codex.exe`、`code_mode_host`、`models_cache` 与 `TYPESAFE_API_KEY` 状态；
   - `active` 查看正在运行的后台 Codex 进程及 `run_id`；`cancel` 一键强杀失控进程。
