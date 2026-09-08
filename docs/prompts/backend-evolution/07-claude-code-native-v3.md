# 后端演进 · 任务 G：Claude Code native Session Protocol v3

## 目标

在 Claude Code provider 边界实现 native Session Protocol v3。以同一次读取构造的
finalized v2 快照为基底，逐字段保留 v2 facts，只添加 Claude transcript 能够证明的
request Usage 与 domain coverage；不得把 sidechain lineage 推成消息投递、团队协作或
后台状态，也不得从 compact operation 推造 context result。

同步刷新 Claude Code 2.1.263 证据。Provider transcript 始终只读。

## 当前证据

- 本机安装 2.1.207；`C:\Users\QQ110\.claude\projects\D--WorkSpace-OpenSession`
  有 11 个 JSONL、132 records、21 assistant fragments、14 个 distinct response ids，
  0 sidechain、0 task notification、0 compaction。
- 本机按 response id 去重后的聚合为 input 131350、output 300、cache read 12032、
  cache write 0、reasoning 0、total 143682；朴素累加 fragment 会重复计费。
- 2026-09-08 npm `latest/next=2.1.263`、`stable=2.1.236`；官方 tag 与 main HEAD
  都是 `ab9b2cf7bb9e4f98ff264c07a22e46d83c29c558`。本机没有 2.1.263 live transcript，
  因此 current-format 扩展必须标记为 official-source/docs verified，而不是 live verified。

## Provider 边界

1. 保留 `getSessionProtocol()` v2；新增 provider-owned `getSessionProtocolV3()`，使用同一
   cached entry/children 输入与 finalized v2，再调用 `finalizeSessionProtocolV3()`。
2. `session/events/relationships/tasks/agentRuns/contextArtifacts/branches/revision` 与本次
   构造的 finalized v2 完全一致；shared runtime 不增加 Claude 分支。
3. Goals、Actors、Coordination、ContextVersions、ContextTransformations 保持空。
   `spawned` 只是 lineage，不生成 spawn/delegate/delivery/ack/handoff observation。
4. Work/Execution coverage 仅根据 finalized v2 Task/AgentRun 是否存在报告
   `observed`/`not-observed`。不得从普通 user prompt、标题、`origin.kind` 或 model
   推断 Goal/Actor/Task/Run。
5. Context 有 compact event/artifact 时为 `unknown`，因为只有 operation/metadata，
   没有 result version；完全无 compaction evidence 时为 `not-observed`。

## Request Usage

1. 复用 `uniqueClaudeAssistantUsageRecords()` 与 `claudeUsageToTokens()`，一个 canonical
   assistant response id 最多生成一个 `UsageRecord(scope=request)`；同一 response 的
   thinking/tool/text fragments 绝不重复计数。
2. `id` 使用稳定 session + response identity；`sessionRef` 指向当前 canonical session；
   `eventId`/`turnId` 只在能够解析到 finalized v2 canonical assistant event 时填写；
   `runId=null`，`contextOriginSlices=[]`。
3. input=`input_tokens`；cache read=`cache_read_input_tokens`；cache write 优先 scalar
   `cache_creation_input_tokens`，否则使用 nested ephemeral 5m+1h；reasoning 来自
   `reasoning_tokens` 或 `output_tokens_details.thinking_tokens`；visible output 为 inclusive
   raw output 减 reasoning。
4. 显式 total 只在与规范化分量一致时保留，否则 total=null，不能悄悄覆盖矛盾证据。
   全零 canonical response 不生成 UsageRecord。
5. 有 request records 时 Usage coverage=`observed`；没有时 `not-observed`。不得生成
   direct/inherited/shared origin slices，也不得把 parent/sidechain 共享上下文归属到请求。

## 当前格式兼容边界

- XML `<task-notification>` 的 `<tool-use-id>` 在官方 SDK 类型中可选；解析时 task id 是
  identity，缺 tool-use-id 只令 correlation/toolCallId 为 null，不能丢弃整个通知。
- status 明确支持 `completed`、`failed`、`stopped`；`stopped` 映射 cancelled。未知或
  缺失 status 不得默认为终态。不要仅因 SDK 流类型存在，就把尚未证实写入磁盘 JSONL
  的 `system/task_started|task_progress|task_notification` 形状加入 parser。
- 保留真实磁盘 camelCase `compactMetadata.preTokens` 支持；SDK 流式 snake_case 字段
  未经磁盘证据不得混入 provider file parser。
- 本阶段不按时间邻近配对 task/sidechain，不从 child 最后一条消息推断完成，不把
  repeated assistant fragments 当多个请求。

## 测试与文档

- 新增 Claude native-v3 tests：v2 facts 保留、14-response style fragment 去重、相邻不同
  response id、无 response id 的相邻 fallback、scalar/nested cache、inclusive
  output/reasoning、矛盾 total、全零 suppression、canonical refs、validator success。
- task notification 测试覆盖 completed/failed/stopped、缺 tool-use-id、unknown status；
  compact 测试确认只有 event/artifact 与 unknown Context coverage，无 transformation/version。
- sidechain 测试确认 lineage 不生成 Coordination；没有明确 request ownership 时 usage
  不绑定 run。
- 更新 README 中英文 provider 表、`docs/CONTRIBUTING-PROVIDER.md`、evidence matrix、
  freshness spec，并新增 implemented decision；历史 decision 保持历史快照。

## 验收

- `npm run review`、focused tests、`npm test`、`git diff --check`。
- 对本机 11 个 transcript 做 adapter/full-protocol smoke：v3 validation 无错误，request
  count 与 14 个 distinct response ids 的实际可计费子集一致，聚合 token 不因 fragment
  重复；记录真实 session/API 数值。
- 重启 Viewer，检查真实 Claude session 的 Work/Execution/Coordination/Context 与 Usage，
  会话 ToC、390px/320px、控制台；确认 transcript 文件 size/mtime 不变。
- 独立 Luna reviewer 审查后修复 findings；提交/推送只含本阶段，不含 `dist/`、日志、
  截图或 `tmp/`。不得使用 Pi/pi-wsl。
