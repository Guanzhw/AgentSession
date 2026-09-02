# Staged implementation specs

这些 spec 是**有界任务分界与验收标准**,不是"粘贴进新会话"的文本。工作流:

主 agent 提供有界 spec → pi-wsl 的 `pi_task` 按 spec 实现 → 独立 `pi_review`
只读审查(范围有界、证据有界、无越界修改)→ 主 agent 汇总验收。

不需要启动 Codex 子代理,也不需要新建会话;每个 spec 自包含仓库事实与必读文件,
执行者无需额外上下文。

## 后端演进(核心先做,协议优先)

1. `backend-evolution/00-bootstrap.md` — 引导与执行边界(必读)
2. `backend-evolution/01-usage-origin-slices.md` — 任务 A(核心):bounded usage-origin 记账。
   当前 HEAD 事实(2026-09-03):**投影侧已完成**——Execution `usage.origins` 有界聚合
   (每组件 total/classified/unclassified/complete + inspectedRecords/
   recordsTruncated/slicesTruncated)与 coverage 语义已落地,决策记录
   `implemented/2026-09-03-bounded-usage-origin-accounting.md`;对 2026-09-03
   snapshot(当下适配器/fixtures/本地已验证快照)的七 provider 审计未发现精确来源
   切片,OpenClaw 最新 SQLite、DSH alpha.5、Pi 0.84.4 等上游新版本尚未 refresh,
   其 slice 状态为 pending/unknown;provider-native origin 映射保持 evidence-pending
   (不发明三分)
3. `backend-evolution/02-harness-environment-evidence.md` — 任务 B(后续可选增强):
   环境清单 + 环境重载。排在核心 provider/ownership 工作之后,证据优先,无证据不落代码
4. `backend-evolution/03-git-commit-association.md` — 任务 C(后续可选增强):
   会话 ↔ git commit 关联。当前只评审、不实现;决策记录保持 proposed
5. `backend-evolution/04-provider-freshness-refresh.md` — **下一阶段 bounded spec
   (不立即实现)**:按证据时效逐 provider 刷新 parser/schema/protocol 映射——DSH
   alpha.5 与 OpenClaw current SQLite 优先,随后 Pi v3/0.84.4、Codex 0.152.1、
   Claude 2.1.258、OpenCode 1.18.26、Hermes remote HEAD;每个 provider 单独决策/
   fixture/真实数据/提交,保持核心 Work Graph provider-native v3 mapping 优先级。

建议顺序:A 的投影部分已落地;剩余的 provider-native origin 映射等待真实证据;B 与 C
相互独立,均在核心工作(usage-origin 记账 + provider-native v3 映射)落地后再评估。

## 前端实现(后端核心项落地之后)

1. `frontend-implementation/00-bootstrap.md` — 引导与执行边界(必读)
2. `frontend-implementation/01-p0-information-skeleton.md` — P0 信息骨架
3. `frontend-implementation/02-p1-library.md` — P1 库页
4. `frontend-implementation/03-p2-conversation-threading.md` — P2 对话线程化
5. `frontend-implementation/04-p3-work-narrative.md` — P3 工作叙事化
6. `frontend-implementation/05-p4-events-and-wrapup.md` — P4 事件标签 + 收尾

P0 做完先给用户看信息骨架再继续;P2 风险最高,拆两个提交。
注意:详情页默认标签是**工作**(已实现决策 2026-09-02 Work Graph-first);
本目录的"对话线程化 / agent 卡 / 检查器"spec 面向对话投影本身,不是默认产品轴。
每个任务完成后回写 `docs/design/ui-v2.md` §7 绑定表,保持 UI 侧与协议侧同步。
