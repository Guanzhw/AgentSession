# 后端演进 · 任务 H：Pi native Session Protocol v3

## 目标

在 Pi provider 边界实现 native Session Protocol v3，并把 provider freshness
刷新到官方 npm 0.85.1 / 当前 upstream HEAD。以同一次只读 file-store entry 构造的
finalized v2 为基底，逐字段保留 v2 facts，只增加 Pi session v3 能直接证明的
request Usage、compaction result Context 与 domain coverage。

本任务由独立 Luna worker 实现、独立 Luna reviewer 只读审查。不得调用 Pi、
pi-wsl 或直接 WSL，不升级用户安装，不写 provider transcript。

## 当前证据（2026-09-08）

- Windows 本机 `pi --version` 为 0.80.10；当前 Viewer 的 Windows Pi 数据源只有
  1 个真实 session，因此它只能验证兼容读取，不能证明 0.85.1 新字段的 live shape。
- npm `@earendil-works/pi-coding-agent` latest 为 0.85.1；tag/gitHead 为
  `d981de1229ef899957bbe968bc8dcda02a21f477`，发布于 2026-09-05。官方仓库
  当前 HEAD 为 `f53ac1135149f03fd1e2a5bfd29861120eaf5b96`。
- 0.84.4 → 0.85.1 的 session-format/usage/compaction 存储契约没有版本升级，
  `CURRENT_SESSION_VERSION` 仍为 3。0.85.1 assistant message 已包含可选
  `responseId`、`responseModel`、`providerThinkingLevel`、`deferred`，Usage 包含
  `cacheWrite1h` 与 `reasoning`；`stopReason` 包含 terminal `deferred`。
- 当前 HEAD 文档澄清：`firstKeptEntryId` 是 compaction 的必需保留边界；
  `buildSessionContext()` 用 compaction summary 替换边界以前的内容，并保留
  `firstKeptEntryId` 起至 compaction 前的条目以及 compaction 后条目。
  `branch_summary` 是切换分支后注入新路径的摘要。旧的 `retainedTail` 继续只作为
  历史/harness 扩展证据读取，不再称作当前官方标准字段。
- Pi 的 session totals 仍统计所有已记录 assistant、toolResult nested usage、
  compaction/branch-summary summary usage；但 toolResult 与 compaction 的官方类型
  允许聚合 nested work 或 LLM call(s)，不能把这些聚合记录强行声明成一个 request。

## Provider 边界

1. 保留 `getSessionProtocol()` v2；新增 provider-owned `getSessionProtocolV3()`。
   v2/v3 必须复用同一 cached entry、同一 branch topology 与同一 finalized v2，
   最后调用 `finalizeSessionProtocolV3()`；shared runtime 不增加 Pi 分支。
2. `session/events/relationships/tasks/agentRuns/contextArtifacts/branches/revision`
   与该次 finalized v2 完全一致。
3. Goals、Actors、Coordination 保持空。`parentSession` 仍只是 parent lineage；
   nested `run-N` 路径、deferred provider response、tool 名或目录邻近都不能变成
   Task、AgentRun、spawn、delivery、handoff 或 team facts。
4. Work 与 Execution coverage 保持 `not-observed`；Coordination 为
   `not-observed`。不得用零实体反推 unsupported，也不得把 provider-level deferred
   response 当成已观察到的后台 agent execution。

## Request Usage

1. 每个真实顶层 `message.role=assistant` entry 最多生成一个
   `UsageRecord(scope=request)`，包括 active 与 abandoned/history branches，因为它们
   都是实际已发生的 provider requests；不得展开或重复统计嵌入字段。
2. request identity 优先使用非空 `message.responseId`，否则使用 entry `id`；若同一
   responseId 重复落盘，只保留一次。`sessionRef` 为当前 canonical session，
   `eventId`/`turnId` 仅在能够绑定 finalized-v2 assistant event 时填写；`runId=null`、
   `contextOriginSlices=[]`。
3. model 优先 `responseModel`，其次 `model`。input/cacheRead/cacheWrite 使用 Pi 原字段；
   reasoning 是 output 的子集，visible output 必须减去 reasoning。`cacheWrite1h` 是
   cacheWrite 的子集，不能再次相加。显式 `totalTokens` 只在与规范化互斥分量一致时
   保留，矛盾时为 null；全零 deferred/pending marker 不生成记录。
4. toolResult usage、compaction usage、branch_summary usage 继续进入既有 provider
   billed session totals，但不进入 request UsageRecords：官方契约把它们描述为 nested
   work 或 call(s) 的聚合，缺少稳定 request identity/cardinality。Usage coverage 的
   details 必须明确 native v3 是 assistant-request 级，不能暗示等于 session billed total。
5. 有 assistant request records 时 Usage=`observed`，否则 `not-observed`；任何情况下
   都不得发明 direct/inherited/shared origin slices。Pi transcript 没有共享上下文 token
   的精确归属证据。

## Compaction result Context

1. 只对 `activePiEntries(records)` 上带非空 summary 的 `compaction` 与
   `branch_summary` 建立 `ContextVersion` + `ContextTransformation`。它们分别证明
   compact 后重建上下文的摘要结果、以及 branch navigation 后注入的新路径摘要。
2. ID 使用稳定 entry id；version 连接对应 finalized-v2 summary artifact，transformation
   连接对应 `context.compaction` event。kind 使用 `compaction`，provenance sourceType
   保留 `pi.entry:compaction` / `pi.entry:branch_summary` 差异。没有明确版本身份时
   `sourceVersionIds=[]`，不要按时间或数组邻近发明 parent version。
3. `firstKeptEntryId` 只作为 recorded retained boundary；不得把 entry id 当成另一
   ContextVersion。历史 `retainedTail` 只保留 count metadata，绝不展开成消息或 token。
4. 至少一个 readable result 时 Context=`observed`；存在 compaction operation 但没有
   readable result 时为 `unknown`；完全没有 compaction/branch-summary evidence 时为
   `not-observed`。

## Current-format refresh

- Parser/message metadata 有界保留 `responseId`、`responseModel`、
  `providerThinkingLevel` 与 deferred 的存在/终态事实；不要暴露完整 provider deferred
  handle，也不要从 handle 推断 task/run/coordination。
- README 中英文、provider guide、evidence matrix、freshness spec 更新到 npm 0.85.1、
  tag/gitHead 与独立 upstream HEAD；明确本机 0.80.10、无 live 0.85.1 transcript。
- 修正 `docs/prompts/README.md` 中已经完成却仍写“剩余 Hermes”的陈述，并加入本任务。
- 新增独立 implemented decision；旧的 0.84.4 decision 保持历史快照。

## 测试与验收

- 新增 native-v3 focused tests：v2 facts 原样保留；responseId 去重；entry-id fallback；
  responseModel；reasoning/output 与 cacheWrite1h 不重复；矛盾 total；全零 suppression；
  abandoned assistant request 计入、retainedTail 副本不计入；tool/summary 聚合不冒充 request。
- Context tests：active compaction 与 active branch_summary 产生 result version/
  transformation；abandoned compaction 不产生 active result；空 summary 只有 unknown
  operation；event/artifact refs 与 validator success。
- 当前 0.85.1 source-derived fixture 可以扩展既有 bounded fixture；不得提交 live data。
- `npm run review`、focused tests、`npm test`、`git diff --check`；对 Windows 本机真实
  Pi session 做 adapter/full-protocol/API smoke 并比较 transcript size/mtime；重启 Viewer
  检查 Work/Execution/Coordination/Context/Usage、ToC、390px/320px 与控制台。
- 独立 Luna reviewer 后由主 agent 修复 findings；提交/推送仅含本阶段，不含 `dist/`、
  日志、截图、`tmp/` 或临时 upstream clone。
