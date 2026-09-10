# 后端演进 · 任务 K：DSH alpha.2 Session format v3

## 目标

让 DeepSeek Harness provider 跟进当前最新官方版本
`@deepseek-ai/dsh@0.1.5-alpha.2`，以只读方式读取原生 Session format v3，
同时保留 v0、v1、v2 历史格式。Provider session 继续是 canonical 存储边界；
AgentSession 不迁移、不发布也不修改 DSH 文件。

OpenClaw 已冻结，不在本阶段修改范围内。

## 官方证据

- npm：`@deepseek-ai/dsh@0.1.5-alpha.2`，发布于 2026-09-09。
- tag：`dsh-v0.1.5-alpha.2`；commit：
  `b2e3b2a0125854567a4a5fcba75782e42fe84901`。
- `packages/core/session/src/types.ts` 将 `SESSION_FORMAT_VERSION` 提升为 `3`。
- `packages/session/session-persistence-jsonl` 使用
  `session.v3.jsonl` / `session.v3.jsonl.zstd`；物理 JSONL 与独立 Zstandard
  frame 机制延续 v2。
- `packages/session/session-format-v2-to-v3/README.md` 记录非恒等迁移：system
  prompt 从 `request/header.data.header.system` 移到 `system/message` surface；
  replacement envelope 从 `start/end` 改为 `startSeq/endSeq`；
  `tool/code-dispatch*` 改名为 `tool/ptc-dispatch*`。
- 当前 generated event catalog 新增 `deliverables/presented`、`subagent/catalog`、
  `system/message` 与 PTC tags，并移除两个 code-dispatch tags。

## 存储与版本选择

1. `DshSessionGeneration` 扩展到 `0 | 1 | 2 | 3`，识别 v3 raw 与 Zstandard
   canonical 文件名。
2. 每个 session root 仍只选择数字最高 generation。混合编码、同代重复文件、
   或最高代解析失败继续产生明确诊断；不得回退到较老代。
3. v0/v1 packed-row、v2 envelope 与既有继承语义保持冻结回归。
4. v3 每行一个 event；packed rows 必须拒绝。header 使用 v2 起的 `isSeeded`、
   `delegationDepth` 和 tagged `session/end-seed` cut。
5. source 文件大小、mtime 与内容在真实验证前后不变。

## 原生 v3 边界验证

只验证 AgentSession 消费或安全读取所需的官方边界，不复制 DSH 的完整 restorer：

- event envelope 只允许 `type, seq, time, data, ignorable, sourceEventSeqs,
  surfaceOp`；sequence 连续，time 非负，data 为 object。
- 四类 surface 为 `system/message`、`user/message`、`assistant/message`、
  `tool/result`，均要求 `surfaceOp`。
- v3 replacement 仅接受 `{ op: "replace", startSeq, endSeq }`，拒绝 v2 的
  `start/end` 别名；端点必须是当前 surface 中按顺序存在的 inclusive span，
  source provenance 必须完整覆盖被替换节点。
- `assistant/message` 禁止 `sourceEventSeqs`；其他 surface 若提供则必须非空、
  唯一且只引用更早事件。known log-only event 禁止 surface metadata。
- `request/header.data.header.system` 在 v3 中已退休，出现即拒绝。
- native v3 必须拒绝 required predecessor `tool/code-dispatch*`；
  `tool/ptc-dispatch*` 作为当前已知 log-only 事件接纳。
- 未知普通事件只有在 `ignorable: true` 时可保留为 opaque log evidence；未知
  required 事件拒绝。不得让 opaque 事件满足当前 PTC 或 surface 关系。
- `system/message` 加入 surface replay，但不进入人类 Conversation/ToC；它只为
  system prompt evidence 与 Context/runtime 投影提供来源。
- seeded/unseeded 与 inherited marker 的一致性规则扩展到 v3。

## Provider 与协议投影

- 更新 DSH compatibility snapshot、官方 tag/commit/package、format version、事件目录、
  fixture provenance 和中英文 provider 文档。
- transcript 仍只显示 append-origin user/assistant/tool 内容；surface replacement
  作为上下文演进证据，不重写使用者已看到的历史 transcript。
- `dshStoredSystemPrompt()` 优先从 v3 有效 system surface 读取；v0–v2 保留既有
  request-header evidence。空 system head 表示明确的无 system prompt，不回退旧值。
- native Session Protocol v3 builder 保留既有 Work、Execution、Coordination、Usage
  事实，并识别 PTC lifecycle event vocabulary；不得从 `system/message`、
  或 `deliverables/presented` 发明 Task、Run、Goal 或 token ownership。
  `subagent/catalog` 本身是 parent-owned direct-child discovery：保留 childId、
  childCreatedAt、mode、label，并投影 exact spawned relationship 与
  spawn/started coordination；只有子 session 存在时绑定 Actor/session，且不推断
  terminal Run/Task。`deliverables/presented` 仅保留 callId 与 bounded file
  metadata/count。
- direct / inherited / shared request-origin slices 仍保持 unknown，除非 v3 新记录中
  出现可逐请求绑定的明确证据。

## 测试

至少覆盖：

1. v3 raw 与多 frame Zstandard 读取、发现和最高代选择。
2. v3 header、dense seq、packed row 拒绝、未知 required/ignorable 分流。
3. 四类 surface append/replacement、`startSeq/endSeq`、完整 provenance、assistant
   provenance 禁止、log-only metadata 禁止。
4. 退休 system header 与 predecessor code-dispatch 拒绝；PTC tags 接纳。
5. system surface 的有效 prompt、清空、replacement，以及 Conversation 不显示 system。
6. seeded v3 inherited cut、未标记/冲突 marker 拒绝。
7. v0/v1/v2 fixtures 与 token 去重/usage 回归不变。
8. official 或严格 source-derived v3 fixture 带 tag、commit、upstream path 与 SHA-256。
9. v3 finalized Session Protocol v3 validation 为零错误，四类图和 usage 不产生无证据事实。

## 验收

- `npm run typecheck`、DSH focused tests、`npm test`、`npm run review`、
  `git diff --check`。
- 检查当前本机 DSH 版本与真实 session generations；如有 v3 数据，通过 provider、
  session、protocol/runtime APIs 与浏览器验证。若只有旧代真实数据，明确记录 live
  证据边界，并用官方 v3 fixture 完成格式验证。
- 重启 Viewer，浏览器检查 DSH Conversation、Work、Execution、Coordination、Context、
  Events 与 320/390px；控制台和服务日志无新增产品错误。
- 独立 Luna 只读审查并修复 findings；本阶段独立提交并推送，不包含 `dist/`、日志、
  截图、`tmp/`，不修改 OpenClaw。
