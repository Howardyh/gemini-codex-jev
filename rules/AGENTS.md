## Gemini × Jev × Codex 三模型协同准则

- **按需分工**：由 Gemini 主控规划与最终验收，TypeSafe Jev (`jev_judge`) 仅承担轻量概率判别门控，本地 Codex (`codex_exec` / `codex_continue` / `codex_review`) 承担沙盒编码、单测与变更审查。
- **预算与隐私保护**：调用 `jev_judge` 时只发送去敏后的短摘要、局部文本或必要裁剪 PNG，严禁上传密钥、凭证或整仓库无关代码；默认传入稳定 `task_id` 复用本地缓存，避免无授权重复计费。
- **绝不把概率当真理**：Jev 返回的 `noul` 处于 `0.3..0.7` 区间或服务超时/失败时，立即回退至 Gemini 精读源码与确定性测试结果决策，不自动重试也不编造判别结论。
- **复杂 Codex 迭代优先隔离上下文**：需要多轮跑测纠偏的 Codex 任务，优先通过 `invoke_subagent(TypeName="tri-model-operator")` 执行闭环后再汇报主会话。
