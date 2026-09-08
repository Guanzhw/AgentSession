# 后端演进 · 任务 I：Goal paused 公共状态

## 目标

给 Session Protocol v3 的 `GoalStatus` 增加 `paused`，并让已记录该状态的
DeepSeek Harness 映射保持原义。该变更先于 OpenClaw native v3：OpenClaw
2026.9.3 的官方 `SessionGoal.status` 同样记录 `paused`，因此这已是两个 provider
共同、可复用且当前协议无法表达的缺口。

本阶段由独立 Luna worker 实现、独立 Luna reviewer 只读审查。不得调用 Pi、
pi-wsl 或 WSL；不得修改 provider 数据；不得顺带实现 OpenClaw native v3。

## 证据与边界

- DSH 当前 provider-native v3 已解析 recorded goal phase `paused`，但
  `dshGoalStatus()` 因公共枚举缺失而降为 `unknown`。
- OpenClaw `v2026.9.3` 官方
  `packages/gateway-protocol/src/schema/sessions-goal.ts` 把 `paused` 列为稳定
  `SessionGoal.status`，与 DSH 形成第二份独立 provider 证据。
- 本阶段只增加 `paused`。OpenClaw 的 `usage_limited`、`budget_limited` 尚无第二个
  provider 的公共证据，不扩展公共枚举；它们将在 OpenClaw 映射阶段按共享语义处理。
- 不改变 Task/AgentRun 状态，不改变 v2，不新增兼容分支或 provider-id 判断。

## 实现要求

1. 在 `src/providers/shared/session-protocol-v3.ts` 的类型与 runtime validator 状态集合
   同步加入 `paused`；工厂与 finalized validator 均接受它，未知值仍拒绝。
2. `src/providers/deepseek-harness/protocol.ts` 将 recorded phase `paused` 映射为
   `paused`，删除“无等价状态”的旧注释；其他 phase 映射不变。
3. 英文/中文 locale 增加 `runtime.status_paused`，Work Graph 显示本地化文本；CSS
   为 paused 使用非成功、非失败的静态状态颜色，保持窄屏与无障碍结构不变。
4. 更新 protocol design/evidence matrix 中 DSH paused 语义和本任务索引；新增一份
   implemented decision，明确“双 provider 证据才扩展公共枚举”的理由。

## 测试与验收

- 更新 v3 factory/validator 测试：`paused` 可通过，未声明状态仍失败。
- 更新 DSH native-v3 test：recorded paused goal 精确输出 `paused`。
- 增加/更新 SSR 与 locale 断言，证明 paused 标签使用本地化 key，且 CSS 状态可识别。
- 运行 focused tests、`npm run review`、`npm test`、`git diff --check`。
- 独立 Luna reviewer 后由主 agent 处理 findings；本阶段独立提交/推送，不包含
  OpenClaw adapter 代码、`dist/`、日志或临时 upstream clone。
