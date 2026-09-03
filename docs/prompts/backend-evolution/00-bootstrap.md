# 后端演进 · 引导与执行边界

```text
仓库:AgentSession——本地优先、跨 7 个 provider(OpenCode/Claude Code/Codex/
OpenClaw/Hermes/Pi/DeepSeek Harness)的 AI 编码会话查看器。Node ESM、零运行时依赖、
SSR + 原生 JS;服务器在 127.0.0.1:3456。

工作流(主 agent 分派):主 agent 提供本有界 spec;由 pi-wsl `pi_task` 实现;
完成后由独立 `pi_review` 只读审查(范围有界、证据有界、无越界修改);主 agent 汇总验收。
执行者不需要新建会话或把文本粘贴到其他会话。

执行前先读:
1. AGENTS.md —— 不变量(provider 数据只读、证据有界、决策生命周期)与验证矩阵,全部遵守;
2. docs/specs/work-graph-protocol/design.md —— Session Protocol v3 规格;重点是
   §Request usage(origin slices: direct/inherited/shared 已定义)与文末 Evolution backlog;
3. docs/specs/runtime-protocol-workbench/design.md —— v2 事件词汇表,文末 §10 Backlog;
4. docs/specs/work-graph-protocol/evidence-matrix.md —— 各 provider 证据现状;
5. .agents/decisions/README.md 和 implemented/ 下最近几条记录 —— 决策记录格式与近期事实。

背景:UI v2 信息设计(docs/design/ui-v2.md,只读参考;§7 是 UI 元素↔协议字段
绑定表,§11 开放问题)。总体目标来自一个真实 Codex 会话的目标描述:建立
direct/inherited/shared token ownership;异步任务、后台运行、持续 subagent 交互、
compact/dream/memory/experience、teams/swarm 能被准确呈现和统计;不同 scope 的
memory/experience/userInfo 作为 provider 可选项展示。完整 UI 重设计
(docs/design/ui-v2.md P0–P4)是同一 Work Graph 演进目标的主要后期阶段,沿用该
P0–P4 计划,不另立平行架构;在核心后端项落地后按 frontend-implementation/ 推进。

当前 HEAD 事实(2026-09-02 两个提交,均已完成):
- Codex native Session Protocol v3 映射已实现(goals/actors/coordination/context/
  usage,决策 2026-09-02-codex-native-v3-mapping.md);usage 记录含归一化组件与
  additive 语义,但**不含来源切片**——Codex 明确不记录 request context origin;
- Codex 0.151+ 用户消息恢复已实现(response_item/role=user + user.text 标记,
  决策 2026-09-02-codex-new-format-user-messages-and-v3-audit.md);
- 下一步核心后端工作:有界 usage-origin 记账(投影暴露 origin 聚合 + coverage,
  保持 additive 不重复计数)+ 由真实证据驱动的其他 provider native v3 映射;
- 环境清单/重载(任务 B)与 git 关联(任务 C)是更后置的可选增强,
  排在核心 provider/ownership 工作之后。

> Update (2026-09-03):任务 A 的投影部分已落地——Execution `usage.origins`
> 有界 origin 聚合与 coverage 语义已实现(决策记录
> `.agents/decisions/implemented/2026-09-03-bounded-usage-origin-accounting.md`),
> 对当时 snapshot(适配器/fixtures/本地已验证快照)的七 provider 审计未发现精确来源
> 切片:DSH alpha.5 已于同日完成 refresh(官方 snapshot/源码确认无 origin-slice
> 记录,credentialed live run 仍不可用),OpenClaw 最新 SQLite、Pi 0.84.4 等
> 其余上游新版本未 refresh,slice 状态 pending/unknown;provider-native origin
> 映射保持 evidence-pending;其余内容作为历史 bootstrap 保留。

验收数据:Codex 会话 01a0576a-98e2-7c31-a265-6d98d5fbff12(1 目标/13 任务/
13 子代理/10× 压缩)。纪律:证据有界(不发明 provider 没记录的事实);非平凡改动走
决策记录生命周期;改动后跑 npm run build / npm test / npm run check:governance,
并用真实数据验证;提交独立可审查。完成后按实际落地同步更新 docs/design/ui-v2.md
§7 绑定表与 work-graph spec Evolution backlog 状态。
```
