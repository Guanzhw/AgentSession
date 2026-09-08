# 后端演进 · 任务 F：Hermes native Session Protocol v3

## 目标

在 Hermes provider 边界实现 native Session Protocol v3。以同一次读取构造的
finalized v2 快照为基底，逐字段保留 v2 facts，只添加 Hermes SQLite 能够证明的
async coordination。Goal、Actor、request Usage、context result version 与 async
handle→child 绑定均不得推断。

同时刷新 Hermes v0.21.1 / schema 30 证据，并按官方语义区分 async registry 的
canonical spawner、旧 CLI session key 与 API wake target。Provider SQLite 始终只读。

## 当前证据

- 本机只读库 `C:\Users\QQ110\AppData\Local\hermes\state.db`：4 sessions、21 active
  messages、1 async delegation、4 session model usage aggregates、0 compacted messages。
- root `20260802_213050_502174` 有 async row `deleg_248f389a`：task state 为
  `completed`，但 `delivery_state=pending`、`delivery_attempts=0`、`delivered_at=null`。
  task 完成与结果送达必须是两个独立事实。
- child `20260802_213105_0ef4d7` 记录 `_delegate_from` lineage 与
  `end_reason=agent_close`，但 registry 没有稳定 handle→child correlation key。
- 本机 schema marker 为 23。2026-09-08 官方最新 release 为 v0.21.1 / tag
  `v2026.9.7`，commit `2237be355906fbe6065ce1815711eee52b2d646e`；main HEAD
  `6e2b8e070d28b1a3381a3fb290b6b8d6cce13cef`，schema 30。实施者必须复核官方
  `hermes_state_common.py` 与 `tools/async_delegation.py` 的当前字段，并在文档中区分
  release tag、HEAD、本机旧 schema 和真实 PRAGMA。

## 存储边界

1. 继续使用 `DatabaseSync(..., { readOnly: true })`，不得迁移、写回或修复 provider DB。
2. `parent_session_id` 是 canonical persisted spawner；本机旧 CLI 数据可用
   `origin_session` 作为 session-key fallback。当前官方 `origin_session_id` 只是 API
   completion wake target，不得成为 provider-session owner。在 store 边界规范化一次，
   再交给 typed same-process contract。
3. 只读取 native v3 实际消费或诊断所需字段。不要为了“以后可能用”扩展
   `event_json`、`result_json`、claim/drop 等无当前消费者字段。
4. owner 不存在或不指向可见 session 时保留 session 可读性，不把 row 错绑给相邻
   session。optional registry 失败继续沿用现有显式诊断策略。

## Native v3

在 `src/providers/hermes/protocol.ts` 增加 provider-owned v3 builder，由 adapter 提供
`getSessionProtocolV3()`，并调用 `finalizeSessionProtocolV3()`。复用同一 entry/family
输入和 finalized v2；不得在 shared runtime 添加 Hermes 分支。

### v2 facts 与 coverage

- `session/events/relationships/tasks/agentRuns/contextArtifacts/branches/revision` 与
  finalized v2 完全一致。
- Goals、Actors、ContextVersions、ContextTransformations、UsageRecords 均为空。
- Work：有 v2 Task 时 `observed`，否则 `not-observed`。
- Execution：有 v2 AgentRun 时 `observed`，否则 `not-observed`。
- Context：有 compaction event/artifact 时 `unknown`（只有操作/lineage，没有结果
  version）；完全没有 context evidence 时 `not-observed`。
- Usage：检测到 session aggregate token 字段时 `unknown`，因为 v3 只接受 request
  scope；完全没有 aggregate evidence 时 `not-observed`。不得把附着到最后一个
  assistant 的 `usageScope=session` 伪装成请求，也不得生成 origin slices。

### Coordination

每个 canonical async registry row 按 provider source identity `delegation_id` 生成有界
current-state observations：

1. dispatch：`delegate/requested`，timestamp=`dispatched_at`，fromSessionRef 为当前
   owner session，taskId/correlationId 为 delegation id，eventId 指向现有 async event。
2. lifecycle：仅对可识别的 recorded state 生成第二条 `delegate` observation：
   running/finalizing→`started`，completed/success→`completed`，failed/error/timeout/
   stalled→`failed`，interrupted→`cancelled`。terminal timestamp 优先 `completed_at`，
   其他状态使用 `updated_at`；缺时间保持 null。不要从 Task status 反向补事实。
3. delivery：仅当 `delivery_state` 存在且可识别时生成独立 `result-delivery`：pending/
   queued→`requested`，delivered/success→`delivered`，failed/error/dropped→`failed`，
   cancelled→`cancelled`。delivered timestamp 仅用 `delivered_at`，否则用
   `updated_at`；attempt count 只留 provider evidence，不表示 ack。
4. observation 不绑定 runId、childSessionRef 或 recipient Actor。`_delegate_from` 和
   spawned relationship 只是 lineage，不能推成 spawn coordination；不使用时间邻近
   猜 registry handle 与 child。
5. 不生成 result-acknowledgement、handoff、mailbox、team、wait、follow-up。
6. 有 observation 时 Coordination=`observed`，否则 `not-observed`。

## OpenCode 审查尾项

与本阶段一起补齐上一阶段两个测试精度项，不改 OpenCode 生产逻辑：

- 在真正的 OpenCode tree/store 边界验证 claimed child 缺失或 parent mismatch 时不绑定，
  并验证一个 canonical child 不产生重复关系；不要向已规范化 tree 注入不可能状态。
- zero-token suppression fixture 使用已核验的官方 aborted/error assistant shape，而不只
  依赖测试记录名称。确认 canonical message 仍只产生零条 UsageRecord。

## 测试与文档

- 新增 Hermes native-v3 fixture/tests：v2 facts 保留、async dispatch/lifecycle/delivery
  分离、真实 `completed + pending`、unknown state、缺 owner、无 handle→child 绑定、
  child terminal 独立、compression no-result、aggregate usage no request record、coverage、
  validator success。
- store tests 覆盖 canonical `parent_session_id`、旧 `origin_session` fallback、
  `origin_session_id` wake-target collision，以及缺失 owner 不错绑。
- 更新 README 中英文 provider 表、`docs/CONTRIBUTING-PROVIDER.md`、evidence matrix、
  freshness spec，并新增 implemented decision。历史 decision 保持历史事实，不改写。

## 验收

- `npm run review`、focused tests、`npm test`、`git diff --check`。
- 重启 Viewer；对 root `20260802_213050_502174` 与 child
  `20260802_213105_0ef4d7` 检查四个 Runtime API、零 validation diagnostics、
  `completed` task 与 `pending` delivery 同时存在、child run 不绑定 async task。
- 浏览器检查 Work/Execution/Coordination/Context、会话 ToC、390px/320px、控制台。
- 记录 Hermes DB size/mtime 前后不变。
- 独立 Luna reviewer 审查后修复 findings；提交/推送只含本阶段与上述 OpenCode 测试
  尾项，不含 `dist/`、日志、截图、`tmp/`。
