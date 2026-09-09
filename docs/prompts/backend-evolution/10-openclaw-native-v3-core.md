# 后端演进 · 任务 J：OpenClaw native Session Protocol v3 core

## 目标

在 OpenClaw provider 边界实现 native Session Protocol v3，并修正当前 v2
branch 引用的 canonical identity 缺陷。实现只使用当前 adapter 已读取的
`session_nodes`、`session_windows`、`transcript_events` 与 legacy JSONL 证据；高级
SQLite 表（pending input、tool outcome、heartbeat、memory provenance、全局 task/run/
delivery state）留到后续独立阶段。

本阶段由独立 Luna worker 实现、独立 Luna reviewer 只读审查。不得调用 Pi、
pi-wsl 或 WSL；不得升级本机 OpenClaw；provider SQLite/JSONL 必须严格只读。

## 当前证据（2026-09-09）

- 官方 npm latest 为 `openclaw@2026.9.3`，发布于 2026-09-08；release commit 为
  `1391f7cd2d40ab5bbcf2f5f831d3a64f520e72d7`。审计时 upstream HEAD 为
  `0140d656b1012a3059fd8f769952485a58b8a4e5`；两者必须作为独立快照陈述，不把
  moving HEAD 写成 release 内容。
- v2026.9.3 仍使用 state schema 16 / agent schema 19；官方 agent schema SQL
  SHA-256 为
  `fe93217454642e911608f81afc53c9fb3bb7c20cc32bc73f8f6eeaaf232b91b8`。
- `session_nodes.entry_json` 是 canonical logical-session entry。官方
  `SessionEntry` 记录 goal、created actor、owner、parent/spawn/fork、createdVia、
  spawnDepth、subagent role/control scope、started/ended/runtime、run status/error、
  swarm metadata 与 usage-family lineage；`session_windows` 记录 generation lineage。
- 官方 `SessionGoal.status` 是 `active | paused | blocked | usage_limited |
  budget_limited | complete`。公共协议已有 `paused`；OpenClaw-only limited states
  在本阶段映射为共享 `blocked`，并在 bounded provenance 保留原值，不扩展
  公共枚举。
- transcript current shape仍是 session-tree records：message、compaction、
  branch_summary、reset、custom、custom_message、label、session_info 等。
  `compaction` 记录 summary/firstKeptEntryId/tokensBefore；`branch_summary` 记录
  summary/fromId；`reset` 只证明 boundary/reason，不证明 readable result。
- 本机 `openclaw --version` 为 `2026.7.1-2 (0790d9f)`，只有一个 legacy JSONL
  `agentsession-openclaw-smoke-20260802`，没有 current SQLite live sample。该真实
  transcript 有 11 条 records、3 个 assistant usage requests；现有 v2 输出存在两个
  `BRANCH_EVENT_DANGLING` warning，因为 branch 使用 raw record id，而 event 使用
  `record:<id>`。

## Boundary normalization

1. `sqlite-store.ts` 在 `entry_json` 这个不可信边界一次性、字段级、有限地规范化
   native-v3 所需事实。给 `OpenClawSqliteSessionEntry` 增加明确类型的 provider facts；
   不把原始 `entry_json` 或任意 plugin state 塞进 `RawSession.metadata`，下游不重复做
   shape probing。
2. 本阶段只规范化：goal；createdActor/owner；createdVia；spawnDepth；subagentRole；
   startedAt/endedAt/runtimeMs/status/lastRunError；swarmGroupId/swarmCollector；
   completionOwnerSessionKey；usageFamilyKey/session ids。数组和文本均设合理 bound。
3. 列字段继续优先用于 canonical lineage；entry-json facts 只表达其拥有的语义。
   `contextTokens` 是容量而非 usage，`usageFamily*` 是 request lineage/dedup clue而非
   direct/inherited/shared token ownership。
4. current SQLite 与 legacy file 必须通过一个明确的 provider-owned v3 input/builder
   契约进入映射；shared runtime 不增加 `provider.id === "openclaw"` 分支。

## Canonical v2 correction

1. v2 为所有已存储的非-header transcript records 建立 canonical events，而不只为
   selected active path 建 event；conversation message projection仍只显示 active path。
   这样 abandoned branch 的 branch head 也有真实 event anchor。
2. branch 的 `headEventId`/`forkEventId` 必须引用协议中的 canonical event id
   (`record:<source-id>`)，绝不暴露 raw id。linear-only transcript 的 branch
   `forkEventId=null`；真正分叉的 leaf 才绑定其与其它 leaf 的共同分歧祖先，不能把
   leaf 的直接 parent 当作 fork。
3. branch selection 继续由 provider active-path 算法决定。所有 refs 经过 finalized
   validator；当前真实 legacy session 必须从两个 warnings 变为零 diagnostics。
4. `compaction` 与 `branch_summary` event 使用 `context.compaction`，并为非空 summary
   建 metadata-only summary artifact；`reset` 保留为 provider control/boundary event，
   不伪造摘要。artifact 不携带 plaintext summary。
5. 除上述已证实的 identity/context 缺陷外，v2 session、relationships、tasks、
   agentRuns、revision 与既有字段保持兼容；v3 必须复用同一次 finalized v2 snapshot。

## Native v3 mapping

### Goal

- SQLite focused session 的规范化 `entry_json.goal` 产生一个 Goal；legacy 不产生。
- identity 使用 recorded goal id；objective 作为 description；timestamps/budget 仅取
  recorded finite values。`active→active`、`paused→paused`、`blocked→blocked`、
  `complete→completed`、`usage_limited|budget_limited→blocked`，并通过 bounded
  provenance 保留原始状态。不存在 task membership 时 `taskIds=[]`。
- goal operation receipts 不是 Goal entity，本阶段也不读取该表。

### Actors, AgentRuns, Coordination

- 从 SQLite agent directory identity、明确的 createdActor/owner 事实建立 Actors；
  不从 title、message 文本、tool 名或时间邻近推断 actor。legacy 只可使用目录中已记录
  的 agent id 建 root actor。
- 只有 child session 的 canonical facts 明确 `createdVia="spawn"` 或有限整数
  `spawnDepth>0` 时，parent projection 才建立 child AgentRun；单独 parent/fork lineage
  不足以证明 run。`taskId=null`，`childSessionAvailable=true`。
- run status 映射：queued/running 原义；done→completed；failed/timeout→failed；
  killed→cancelled；缺失→running 仅当当前 child status 明确 running，否则不得猜测，
  使用协议允许的 evidence-bounded状态。timeStart/timeEnd/error/model 仅取 recorded facts。
- mode：有 swarmGroupId/swarmCollector 的 recorded child 为 `team`，否则 spawn child 为
  `subagent`。不得由 child count 推断 swarm/team；本阶段不创建 synthetic team actor。
- 每个确证 child run 建一条 `spawn/started` coordination observation，绑定 recorded
  spawned relationship、child run 和双方 session refs。terminal status 不等于 result
  delivery/handoff/ack；没有明确投递证据就不建立这些 observation。
- Tasks 继续为空。Work coverage 由 Goal 是否有证据决定；Execution 由 Actors/Runs；
  Coordination 由 observations。空数组本身不能反推 unsupported。

### Request Usage

- 每个真实 assistant message entry 最多一个 `UsageRecord(scope=request)`，包括 stored
  abandoned branches；不把 session/window aggregate、toolResult 或 summary usage冒充
  request。
- request identity 优先非空 responseId，否则 namespaced entry id；response 与 entry
  identity space 必须分开。重复 responseId 只保留一次并优先 active/canonical event
  occurrence。
- input/cacheRead/cacheWrite 原义；reasoning 从 inclusive output 中扣除。显式 total
  只有与互斥 components 一致时保留，否则 null。全零 marker 不生成。model 使用
  recorded response/model/provider facts；`runId` 只有确切 owning run 时绑定，否则 null。
- `contextOriginSlices=[]`。usageFamily、spawn lineage、retained context与 parent session
  都不能证明 shared/inherited token 数，因此 UI 只展示本次真实请求 token，不重复计入
  不可归属的共享上下文。

### Context result

- 仅 active path 上带非空 summary 的 `compaction`/`branch_summary` 建
  ContextVersion + ContextTransformation(kind=`compaction`)；version 绑定对应 v2
  metadata-only artifact，transformation 绑定对应 canonical event。
- `firstKeptEntryId`/`fromId` 仅保留 recorded boundary metadata，不把 record id 当作
  parent ContextVersion，不复制其前后的共享消息到 ToC 或 context result。
- 有 readable active result 时 Context=`observed`；有 compaction/branch-summary/reset
  或 SQLite window reason=`compaction` 但没有 readable result 时 `unknown`；完全没有
  operation evidence 时 `not-observed`。abandoned summary 不冒充 active result。

## 明确延后

- `session_participants`、`session_pending_inputs`、`message_tool_run_outcomes`、
  heartbeat outcomes、memory index/provenance、standing intents、全局 state database 的
  task/subagent/flow/delivery 表全部留给后续 OpenClaw advanced-evidence stage。
- 不新增公共协议枚举，不重做 UI，不实现 memory/dream/experience 视觉层，不修改
  provider source data，不安装或升级 OpenClaw。

## 文档与治理

- 更新 `sqlite-store.ts` freshness 注释、README 中英文 provider 表、
  `docs/CONTRIBUTING-PROVIDER.md`、work-graph design/evidence matrix 与 prompt index到
  2026.9.3/release commit/审计 HEAD/schema hash/本机 legacy 限制。
- 新增 implemented decision，记录 boundary normalization、canonical branch修复、
  usage ownership、core/advanced split；旧 2026.8.2 记录保留为历史快照或明确 superseded
  的事实范围。

## 测试与验收

- 新增 `test/openclaw-v3.test.mjs`，并扩展 current SQLite fixture：v2 facts逐字段保留；
  Goal status mapping；actor/owner；spawn-only run与team mode；lineage-only不建run；terminal
  status；无投递推断；coverage。
- branch regression：linear fork null；多 leaf 的 canonical heads/common fork；所有 refs
  可解析且 zero diagnostics；legacy 与 SQLite builders 都覆盖。
- Usage：3 个 distinct requests；response/entry namespace；duplicate response active优先；
  reasoning/output互斥；cache；contradictory total null；aggregate exclusion；无 origin slices。
- Context：active readable compaction/branch_summary result；abandoned summary exclusion；
  reset/window-only operation unknown；完全无 evidence not-observed。
- 运行 focused tests、`npm run review`、`npm test`、`git diff --check`。主 agent 对本机真实
  legacy session做 adapter/v2/v3/API smoke，比较 JSONL size/mtime/hash，重启 Viewer 后
  检查 Work/Execution/Coordination/Context/Usage、ToC、390px/320px 与 console。
- 独立 Luna reviewer 后由主 agent处理 findings；提交/推送只含本阶段，不含 `dist/`、
  logs、screenshots、`tmp/` 或临时 upstream repo。
