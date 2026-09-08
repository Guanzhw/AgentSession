# 后端演进 · 任务 E：OpenCode native Session Protocol v3

## 目标

在 OpenCode provider 边界实现 native Session Protocol v3。以当前 finalized v2
快照为基底并逐字段保留 v2 facts，只添加 OpenCode 真实记录能够证明的 Usage 与
Coordination；Goal、Actor、Context 结果等缺证据部分保持空和诚实 coverage。

同时修正审计确认的三个 v2 normalization 偏差：todo source identity、tool call
correlation、background terminal state。Provider 数据始终只读。

## 当前证据

- 本机 `C:\Users\QQ110\.local\share\opencode\opencode.db` 为只读真实目标；底层表有
  131 sessions、73 parent links、2,968 messages、13,091 parts、182 todos。当前 adapter
  `scan()` 返回 58 个可见 session。
- 代表 session `ses_1ddf03616ffeTE5c6cbpUPMY3n`：10 todos、44 v2 Tasks、34
  Runs、34 relationships、161 个带 usage 的 assistant messages；其 child claims 均有
  精确 provider child id 与匹配的 `session.parent_id`。
- 当前真实库没有 compaction part、context epoch/input row 或 background envelope；这些
  路径只能由已核验官方 shape 与 fixture 证明，必须在文档中标明非 live。
- 2026-09-08 freshness：本机 CLI `1.17.11`；npm latest `1.18.29`，tag
  `16747470f976aca3d362ad730bcd3fe82ecc2c9a`；upstream HEAD
  `ecbc6ccac85b3e8087b6445e584318419b9e2b34`。实施前核对 1.18.27→1.18.29 的
  session/message/part/todo/background schema 差异，并更新 evidence matrix，不能仅改版本号。

## Provider v2 normalization 修正

1. **Todo identity**：OpenCode todo 的 source key 是 `(session_id, position)`。Task id 和
   provenance sourceId 使用该 snapshot-local source key；明确说明重排后的跨快照连续性
   未知。不要继续把 content/priority/time hash 称为 canonical identity。
2. **Tool correlation**：Task `toolCallId` 与 coordination correlation 优先使用记录的
   `part.data.callID`；`part.id` 保持 provider source identity，并继续用于 event/task/run
   自身稳定 id。callID 缺失时 correlation 保持 null，不用 part.id 冒充 callID。
3. **Background status**：`background:true` 只证明 execution mode。只有明确的
   `<task state="completed|error">` 结果 envelope 才能给 background run terminal 状态；
   child 存在、generic tool completed 或 `timeEnd` 均不能单独证明后台工作已结束。
4. **Parent focus**：以 child session 为 focus 时，从该 session 自己记录的
   `parent_id` 暴露一条 incoming parent lineage。Root 构建中已经被 exact launcher
   绑定的 child 不再重复生成 parent + spawned 两条事实。

## Native v3 映射

在 `src/providers/opencode/protocol.ts` 提供 provider-owned v3 builder，并由 adapter
实现 `getSessionProtocolV3()`。复用同一次 tree/v2 输入，调用 shared factories 与
`finalizeSessionProtocolV3()`；不得把 OpenCode 语义放进 shared runtime。

### Work / Actors / Execution

- `tasks`、`agentRuns`、relationships、events、contextArtifacts 与 finalized v2 完全一致。
- Goals 为空；不能从 session title、首条用户消息或 todo 列表推导目标。
- Actors 为空；`session.agent`、message agent/model 只是运行 metadata，没有稳定 actor、
  team 或 mailbox identity。
- Work coverage：有 v2 Tasks 为 `observed`，否则 `not-observed`。
- Execution coverage：有 v2 Runs 为 `observed`，否则 `not-observed`。

### Coordination

- 对 normalized subagent Task/Run 生成至多一个 launch observation：有 exact child 与
  `spawned` relationship 时为 `spawn/started` 并绑定 task/run/toSessionRef；无 child 时
  为 `delegate/requested`，保留已证明的 task/run，不猜 session。
- `data.type="subtask"` structured part 只生成 `delegate/requested` observation，锚定
  `part:<id>` event 与记录的 callID（若有）；不额外创建 v2 Task/Run。
- 仅当 tool output 明确包含 `<task state="completed|error">` 时，增加独立
  `result-delivery` observation；completed→delivered，error→failed，并绑定已知 task/run/
  child。generic tool status 或 timeEnd 不等于 result delivery。
- `session.parent_id` 仍是 lineage，不自动等价为 coordination。
- mailbox、team、follow-up、wait、interrupt、handoff、acknowledgement 均不映射。
- 有 observation 为 `observed`，否则 `not-observed`。

### Context

- v2 `context.compaction` event 与 recorded trigger/tail anchor 保留。
- 当前 source 没有 compaction result version、artifact、summary 或 token result，故
  `contextVersions=[]`、`contextTransformations=[]`，不创建 ContextArtifact。
- 存在 compaction operation 但缺结果时 coverage=`unknown`；完全没有 context facts 时
  `not-observed`。不要从当前 system prompts/runtime config 推导历史上下文。

### Request usage

- 每个 canonical assistant message 最多一条 UsageRecord；event update rows 不参与计数。
- 稳定 id：`usage:<sessionId>:message:<messageId>`；`eventId=message:<messageId>`，
  `turnId=messageId`，timestamp/model 使用 message 的记录字段，runId 保持 null。
- 使用 normalized message tokens 的互斥 input/cacheRead/cacheWrite/output/reasoning。
  五类组件全为 0 的 aborted/error message 不生成 request usage。
- raw total 仅在等于五类组件之和时写入；旧记录 total 小于组件和时设为 null，并保留
  可诊断的 recorded provenance，不能以 max/sum 静默修正 provider total。
- session aggregate 只用于验证，不生成 UsageRecord；无 origin slices，不按时间邻近把
  child request 归到 parent run。
- 有 usage 为 `observed`，否则 `not-observed`。

## 测试与文档

- 新增专门 OpenCode v3 fixture/test，至少覆盖：v2 facts 一致、无伪 Goal/Actor/Context、
  todo source key、callID 与 part.id 分离、child exact/missing/mismatch、structured subtask、
  foreground terminal、background 无 terminal、明确 result delivery、incoming parent、
  coherent/legacy-mismatch/zero usage、event update 不重复、coverage 与 validator 零错误。
- 更新 v2 回归中受源键/correlation/status 修正影响的断言。
- 新建 implemented decision record；同步中英文 README、provider contribution 文档与
  evidence matrix，包括 1.18.29 freshness、真实/fixture 证据边界。

## 验收

- `npm test`、`npm run review`、`git diff --check`。
- 真实只读验证至少覆盖：
  - `ses_06adba800ffeBcOugAu4iwEgft`
  - `ses_1ddf03616ffeTE5c6cbpUPMY3n`
  - `ses_1c00049ceffeUU6O331C1L3n7O`
- 对每个 session 检查 v3 validation、四个 Runtime API、usage 与 message/aggregate 对账；
  记录 SQLite size/mtime 前后不变。
- 重启 Viewer，用真实 OpenCode 页面检查 Work/Execution/Coordination/Context、Conversation
  与 320/390px；控制台和服务日志无新增产品错误。
- 独立 Luna 只读审查后修复 findings；提交并推送时只包含本阶段文件，不含 `dist/`、
  日志、截图、`tmp/`。
