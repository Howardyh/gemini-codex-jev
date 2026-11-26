---
name: tri
description: 启动 Gemini × TypeSafe Jev × OpenAI Codex 三模型协同规划与闭环执行（同 /plan 审批体验：先只读调研与 Jev 路由并输出方案卡片，确认后自动完成 Codex 沙盒编码、Jev 补丁门禁与 Codex 独立审查）。通过 /tri 斜杠命令触发。
disable-model-invocation: true
metadata:
  icon: hub
  logo: logo.svg
---

# `/tri` · Gemini × Jev × Codex 三模型协同规划与闭环执行

当用户输入 `/tri <任务>` 时，你必须严格按照与 `/plan` 一致的两阶段节奏工作：**先只读调研 + Jev 校准路由 + 呈现可审批方案卡片（Phase 1），用户确认后再驱动 Codex 沙盒编码、确定性单测与 Jev/Codex 双重门禁验收（Phase 2）**。

> **免确认直跑规则**：仅当用户在 `/tri` 指令中明确写出“直接执行”“免确认”或“不要停”时，才在生成方案后直接顺滑进入 Phase 2；否则**必须**在 Phase 1 末停下等待用户点击 **Proceed** 按钮。

---

## Phase 1 · 只读调研、Jev 路由与方案审批（严禁提前修改代码）

1. **精准定位代码库（先骨架、再局部）**
   - 优先使用 `tokless skeleton` 或 `grep`/`find` 定位目标函数与 `[L起-L止]` 行号区间，仅按需读取相关代码片段；
   - 若需求存在关键歧义、破坏性变更或架构二选一，使用 `ask_question` 向用户确认后再继续。
2. **前置 Jev 判别与 Codex 额度感知（单轮并行调用）**
   - 调用 `call_mcp_tool(ServerName="gemini-codex-jev_bridge", ToolName="jev_judge", Arguments={ preset: "task_route", task_id: "<稳定任务Slug>", allow_multiple: true, summary: "<去敏后的目标与修改范围摘要>" })`：
     - 读取 `execution_route`（`gemini_direct` / `codex_single` / `codex_subagents` / `review_only`）、`needs_write_sandbox` 与 `needs_visual_evidence`。
     - 若任一核心 `noul` 概率落在 `0.3..0.7` 不确定区间或接口异常，立即由 Gemini 基于源码自行判别，不自动重试、不把概率当绝对真理。
   - 同时调用 `call_mcp_tool(ServerName="gemini-codex-jev_bridge", ToolName="bridge_status", Arguments={ action: "quota" })` 查看本机 Codex 5h/7d 剩余额度，按剩余比例合理决定 `effort`（`medium` / `high`）与并发粒度。
3. **生成可审批方案卡片（`implementation_plan.md`）**
   - 使用 `write_file` 将完整方案写入当前会话的 `<Artifact Directory>/implementation_plan.md`，并务必传入：
     ```json
     {
       "UserFacing": true,
       "RequestFeedback": true,
       "Summary": "<一句话概括任务、Jev 路由结果与主要改动文件>"
     }
     ```
   - 方案卡片必须包含：
     1. **Jev 前置路由与额度看板**（表格展示 `execution_route`、`needs_write_sandbox`、`needs_visual_evidence` 与当前 Codex 5h/7d 剩余额度）；
     2. **三模型职责切分与具体文件改动清单**（按组件列出 `[NEW]` / `[MODIFY]` / `[DELETE]`）；
     3. **验证计划**（明确的测试命令、静态/实机检查点与回退策略）。
   - 若当前未显式声明“免确认直跑”，简短提示用户审阅 [implementation_plan.md](file:///...) 并点击 **Proceed** 后立即结束本回合，等待批准。

---

## Phase 2 · Codex 沙盒实现与双重门禁闭环（批准后执行）

1. **按 Jev 路由策略调度 Codex 沙盒执行**
   - **单点/明确范围修改（`codex_single`）**：直接通过 `call_mcp_tool` 调用 `codex_exec(cwd=..., sandbox="workspace-write", effort="medium"|"high", prompt=...)` 交付精确规格说明。若需跟进修错，在同一 `thread_id` 上调用 `codex_continue(action="resume", ...)`。
   - **跨模块探索或需多轮试错跑测（`codex_subagents`）**：优先调用 `invoke_subagent(TypeName="tri-model-operator", ...)` 隔离高频命令日志（或开启 `codex_exec(..., enable_subagents=true)` 启用 Codex `multi_agent_v2` 协同探索与编辑）。
   - **极小单处只读回答/微调（`gemini_direct` / `review_only`）**：直接由 Gemini 完成，避免不必要的子进程冷启动开销。
2. **本地确定性测试 + Jev/Codex 双重门禁验收**
   - 在最后一次代码修改后运行项目对应的确定性构建或单元测试，取得真实退出码 `0` 与通过计数；
   - 并行调用双重门禁：
     - `jev_judge(preset="patch_gate", task_id="<同一任务Slug>", allow_multiple: true, state={ diff_or_test_summary: "<实际改动统计与全量单测结果>" }, summary="...")`；
     - `codex_review(cwd=..., uncommitted=true, effort="medium")`。
   - 若 `goal_satisfied <= 0.7`、`has_unverified_risk >= 0.3` 或 `codex_review` 给出阻塞性审查意见，立即组织定点修复并**复跑确定性测试**直至全部门禁放行。
3. **更新验收报告与精炼交付**
   - 更新 `<Artifact Directory>/walkthrough.md`（附 `UserFacing: true, RequestFeedback: false`）沉淀改动清单、三模型判别/审查数据与实测结果；
   - 向用户返回简明验收摘要（包含真实文件链接、实测命令结果与 Jev/Codex 协同闭环情况）。
