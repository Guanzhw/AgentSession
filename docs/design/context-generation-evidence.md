# P7：上下文产物的生成来源证据

状态：只读调查，2026-09-17；源码基线 `c27315d`。本次取得了真实的
Codex memory 生成活动及其输入文件证据，尚未实现 Viewer 呈现或完成 P7
产品验收。本文补充[验收记录](runtime-acceptance-evidence.md)的证据范围，
不改变[呈现契约](runtime-presentation-contract.md)。

后续进展（2026-09-19）：[stage1 产物阅读](reader-memory-artifacts.md)和
[后续整理记录](reader-memory-followups.md)现已实现。以下是当时的调查快照；
当前实现与验收范围以这两个专题及验收记录为准。

## 结论

1. 本地 `memories_1.sqlite` 的 52 条 `stage1_outputs` 均能与
   `memory_stage1` job 按原任务 ID、输入版本和完成时间对应。原任务是输入
   来源，不是生成会话。
2. 一次真实 Phase 2 生成活动保留在 `logs_2.sqlite`：明确的生成 thread 和
   turn、读取第一阶段 summary 文件的命令、更新 `MEMORY.md` 和
   `memory_summary.md` 的 patch 均可定位。一个 patch 的 19 条非空新增行
   在当前产物中逐条一致。
3. 该生成 thread 不在当前 `state_5.sqlite.threads` 或
   `thread_history_1.sqlite` 中；当日 session 目录也没有匹配 ID 的 rollout。
   当前 Codex adapter 只发现 session rollout，因此不能打开它的完整 Reader。
4. `memory_consolidate_global` job 与该 Phase 2 活动时间一致，但两者之间没有
   已取得的显式外键。此次不把时间吻合升级为 job → generation thread 关系。
5. OpenClaw 的冻结 schema 有 memory provenance/origin 表，但当前配置位置没有
   对应 SQLite 文件；其他受查 provider 的现有实现主要提供 compact 证据。

## 调查范围与来源

所有 SQLite 连接使用 Node `DatabaseSync(path, { readOnly: true })`。
只读取 schema、聚合计数、已明确 ID 的行及一个固定时间段；未扫描全部 transcript，
未写 provider 数据，未使用 Pi/WSL。正文仅用于内存中的精确匹配，不在本文复制。

本机采样根目录是 `C:\Users\QQ110\.codex`，下文用 `<codex>` 表示。
独立读取发生于 2026-09-17，最后核对时间约 `13:32 UTC`。这些可变数据库中的
计数和保留情况是此次快照事实，不是未来版本的 schema 保证。

| 来源 | 限定读取 | 用途 |
| --- | --- | --- |
| `<codex>/memories_1.sqlite` | `stage1_outputs`、`jobs` 的 schema、计数、一个最新产物 | 输入版本、job、产物内容身份 |
| `<codex>/state_5.sqlite` | `threads` 的指定 ID、source 类别统计、artifact 表计数 | 真实 session 身份和可达性 |
| `<codex>/logs_2.sqlite` | 秒时间窗 `1789621840..1789622104`，随后只读已定位生成 thread | 生成 turn、输入读取、输出 patch |
| `<codex>/thread_history_1.sqlite` | 指定生成 thread 的 `thread_turns` / `thread_items` | 检查是否保留可打开历史 |
| `<codex>/memories/` | 一个指定 summary 的头部/内容匹配，以及日志明确指向的输出文件 | 检查现存产物与记录一致性 |

AgentSession 历史 MCP 工具在本轮不可用，因此使用上述限定的本地只读查询；
CodeFacts generation 147 确认源码定位属于本仓库，再逐处读取实现。

## 第一阶段：产物与原始输入版本

`stage1_outputs` 的实际字段包括：

- `thread_id` 主键、`source_updated_at`、`generated_at`；
- `raw_memory`、`rollout_summary`、`rollout_slug`；
- `selected_for_phase2`、`selected_for_phase2_source_updated_at`；
- `usage_count`、`last_usage`。

`jobs` 的实际主键是 `(kind, job_key)`，并记录 `status`、`worker_id`、
`started_at`、`finished_at`、`input_watermark`、`last_success_watermark`。
它没有独立的 generation session/turn 字段，也不是每次执行的追加历史表。

本次数据库结果：

- `stage1_outputs` 52 条，51 条 `selected_for_phase2=1`；
- `memory_stage1` jobs：132 条 `done`，14 条 `error`；
- `memory_consolidate_global`：1 条 `done`，`job_key=global`；
- 对 52 个现存产物，52/52 有相同 `thread_id=job_key` 的 stage1 job，
  52/52 `source_updated_at=input_watermark`，52/52 `generated_at=finished_at`；
- 51 个选中产物的 `selected_for_phase2_source_updated_at` 与现有输入版本一致。

选中标志说明记录保存了选择状态；它本身不证明某次生成 turn 实际读取了全部
51 个产物，也不能说明用户任务加载或使用了最终 memory。

### 可重复的单条样本

| 字段 | 记录值 |
| --- | --- |
| 输入原任务 `thread_id` / stage1 `job_key` | `01a0aa62-1091-7961-a883-c3e732fe548c` |
| `source_updated_at` / `input_watermark` | `1789565411`，即 `2026-09-16T13:30:11Z` |
| stage1 job 开始 | `1789621842`，即 `2026-09-17T05:10:42Z` |
| `generated_at` / job 完成 | `1789621884`，即 `2026-09-17T05:11:24Z` |
| stage1 job `worker_id` | `01a0576a-98e2-7c31-a265-6d98d5fbff12` |
| 原任务状态表身份 | `source=vscode`、`thread_source=user`；rollout 文件存在 |
| `worker_id` 对应身份 | 也是 `source=vscode`、`thread_source=user`；不是本次下述 Phase 2 thread |

`worker_id` 保留原字段语义，不能直接填入 `producerSession`。它的值能解析为
一个普通任务，不足以证明那个任务的正文就是 memory 生成历史。

这个产物对应现存文件：

```text
memories/rollout_summaries/2026-09-16T13-22-28-TI4c-dark_theme_autonomous_driving_report_html.md
```

文件头的 `thread_id`、`updated_at`、`rollout_path` 指向上述**输入原任务**。
数据库 `rollout_summary` 完整字符串存在于这个文件中，`raw_memory` 完整字符串
存在于 `memories/raw_memories.md` 中。核对未输出正文。

| 内容 | SHA-256 |
| --- | --- |
| 数据库 `raw_memory` | `d2936c9c4817d3b34826bbdd0b4a2025ed0fa38ac54eba96456afcedf891eb2c` |
| 数据库 `rollout_summary` | `6f101803b5e856a2600ae4c913c77251aa62c50067b7072ec4fb3c25266eb81c` |
| 现存 summary 文件整体（含头部） | `32b7ce12c5047c61e9217cd3dbe66c56b61e609555c28fe1d71c6113016ebb69` |

这些身份支持“原任务内容 → 第一阶段产物”的溯源。第一阶段生成调用本身的
独立 session/turn、本次模型请求和输入正文快照仍未取得。

## 第二阶段：真实生成 turn → 输入读取 → 输出 patch

从上面 job 时间窗内的日志找到明确的生成身份：

- generation thread：`01a0adc6-d841-7b33-ac46-2a93664198da`；
- generation turn：`01a0adc6-d88d-7c12-b475-c4d205cd9d0e`；
- 记录工作目录：`<codex>/memories`；
- 输入记录明确命名 `Memory Writing Agent: Phase 2 (Consolidation)`。

身份来自结构化日志的 `thread_id` / `turn_id`，用途来自实际输入记录，不是
标题匹配。固定 thread 的 157 条日志共 233,961 个字符，随后仅提取下列必要证据。

| 日志主键 | UTC 时间 | 可核对事实 |
| --- | --- | --- |
| `56100898` | `05:11:25` | 给上述 thread/turn 提交 Phase 2 生成任务 |
| `56102040` | `05:12:00` | `tools.exec_command` 明确 `Get-Content -Raw` 上述指定 rollout summary 文件 |
| `56102048` | `05:12:00` | 同一 thread/turn 的工具执行完成记录，`call_HTIy0VgjBScU2MSaCRXpZhzv` |
| `56110758` | `05:13:03` | `tools.apply_patch` 请求更新 `<codex>/memories/MEMORY.md`，并引用上述输入 summary |
| `56110761` | `05:13:03` | 同一 thread/turn 的工具执行完成记录，`call_JXApJRccMtCQSQ1io7AClY13` |
| `56112801` | `05:13:42` | `tools.apply_patch` 请求更新 `memory_summary.md` |
| `56115652` / `56115654` | `05:15:02` | 该 thread 收到 Shutdown，agent loop 退出 |

日志 `56110758` 的 patch SHA-256 为
`de37555ae3cad4e88b6cb29b761a9e4d08820e3b2bcfac596dffb622b48aed35`；其中
19 条非空新增行在当前 `MEMORY.md` 中全部存在。`56112801` 的 patch SHA-256 为
`bffe387362805e2d256aca4a8dd057e3d052b8af3e8330b719b8dbf5a91a5faf`；6 条非空
新增行在当前 `memory_summary.md` 中全部存在。

因此已取得的是：**同一明确生成 turn 的输入读取命令、输出修改命令和当前产物
内容一致性**。工具完成日志并不包含内层工具返回正文；当前行匹配也不能恢复
每次 patch 前后的完整文件快照。不要把这些证据扩大为完整输入/输出回放。

另一个读取命令 `56101323` 会在存在时读取 `phase2_workspace_diff.md`，但该文件
现已不存在。当前没有这次 phase2 输入清单的持久快照；不能以当前 51 个选中行
补造那份历史清单。

### 仍不可建立的链接

- `memory_consolidate_global` job 完成时间恰为 `05:15:02`，但记录没有上述
  generation thread/turn 字段。保留“同窗证据”，不建立确定的外键关系。
- generation thread 在 `state_5.sqlite.threads` 中不存在，`thread_spawn_edges`
  无对应边；`thread_history_1.sqlite.thread_turns` / `thread_items` 均无对应行。
  `<codex>/sessions/2026/09/17` 中没有匹配该 ID 的 rollout 文件名。
- 诊断日志保留了真实 generation ID；它目前不是 adapter `getSession()` 可解析
  的已发现 session。不要创建跳向原任务、worker_id 或伪造 session 的“生成历史”链接。
- 本轮没有 memory 被某个用户 turn 加载、reinjection、citation 或改变实际请求
  上下文的证据；生成文件不等于主会话上下文发生了变化。

## 当前代码与其他 provider 的边界

[Codex adapter](../../src/providers/codex/adapter.ts) 的 `discoverSessionFiles()`
只发现 `sessions` 下的 JSONL / Zstd rollouts；当前没有读取上述 memory/job/log
表。[parser](../../src/providers/codex/parser.ts) 的 `extractMeta()` 保存
`threadSource` 和已记录的 parent/spawn 字段，没有 memory 生成映射。

共享 [ContextArtifact](../../src/providers/shared/session-protocol.ts) 已有
`producerRunId`、`producerEventId`、`sourcePath`、`hash`、`sourceSessionIds`。
其中 `sourceSessionIds` 的定义是**产物总结或派生内容的输入来源会话**。
[ContextTransformation](../../src/providers/shared/session-protocol-v3.ts) 已支持
memory / experience / dream 及输入、结果 artifact、run/event/turn。
这些字段可以承载同一已归一化 snapshot 内的生产链；没有独立的跨 session
producer reference，且[输入 session 投影](../../src/protocol-runtime-v3.ts)
使用当前 provider。不要用 `sourceSessionIds` 代替 generator。

| Provider | 调查时已确认的证据 | 调查时缺口 |
| --- | --- | --- |
| OpenClaw | [冻结 schema v19](../../test/fixtures/openclaw-agent-schema-v19.sql) 有 `memory_index_chunks`、`memory_index_chunk_provenance`、`memory_entry_origins`，包含 path/hash、origin_class、session_kind、session_id/session_key | [调查时的 protocol](https://github.com/Guanzhw/AgentSession/blob/c27315d/src/providers/openclaw/protocol.ts) 的 `artifactsFor()` 只处理 compact/branch summary；来源列本身不证明生成 run。需先核实 provider 写入语义 |
| DSH | [protocol](../../src/providers/deepseek-harness/protocol.ts) 保留 compact 的 `sourceCommandId`、shadowed 范围和 summary transformation event | 这些是 compact 输入与结果证据，不是 memory / dream / experience 生成记录 |
| Hermes | [调查时的 protocol](https://github.com/Guanzhw/AgentSession/blob/c27315d/src/providers/hermes/protocol.ts) 有 compression continuation 和 opaque summary | continuation 身份不能替代生成者/输入产物链 |
| Claude | [protocol](../../src/providers/claude-code/protocol.ts) 有 compactUuid、trigger、strategy | 尚无上述辅助产物的归一化生产链 |

本机 OpenClaw 的配置路径是 `C:\Users\QQ110\.openclaw`，仅发现 agent `main`，
但 `agents/main/agent/openclaw-agent.sqlite` 不存在，所以没有 live memory 表或
行可验。[调查时的 OpenClaw store 契约](https://github.com/Guanzhw/AgentSession/blob/c27315d/src/providers/openclaw/sqlite-store.ts) 中
`session_key` 是 canonical logical session，`session_id` 是 transcript window；
未来读取 memory origin 时必须保留该区别。

## 可实施的最小呈现规范

以下是后续实现建议，不是本次新增 API 或批准的共享 schema。

1. **先做已证实的产物读取。** Codex adapter 负责只读 `stage1_outputs` / `jobs`，
   为现存 artifact 暴露稳定的原始键、输入版本、生成时间、内容身份和有界正文续读。
   `thread_id` 链接到输入原任务；同一行被重写时使用输入版本/hash 区别内容。
   复用已有 ContextArtifact 元数据，不把全文塞进 protocol。
2. **分开“产出、输入来源、生成证据”。** 产出正文优先；输入原任务可打开；
   stage1 job 作为 job 证据展示。未知 producer 为空。Phase 2 的日志 generation
   ID 可作为明确但历史不可用的证据，不创建失效 Reader 链接。
3. **真实历史按保留层级展示。** 若以后 provider 有可解析的生成 rollout，才链接
   其 canonical session 并展示自身历史；只有诊断日志时应标记保留范围，不能用
   一组工具调用摘要冒充完整生成会话。日志支持必须由 Codex provider 单独拥有，
   先固定已观察格式并添加真实形状夹具，不能由共享 renderer 解释日志文本。
4. **每条因果边有自己的证据。** 输出与 job 的键/水位匹配、明确读取命令、明确
   patch、输入 summary 的原任务引用分别保存。缺少 job→generation ID、旧文件
   快照或使用事件时保持缺失；不靠标题、相邻时间或 memory/dream 名称补边。
5. **验收以一条真实链为最小单位。** 在真实页面查看完整产出、打开输入原任务、
   核对 generation ID/turn 和日志位置；确认不存在的生成历史有准确说明。
   再覆盖长产物分页、更新版本、缺失文件、窄屏与键盘。不得据本调查把完整 P7
   标为通过，也不扩展到未经采样的 dream/experience 语义。

## 复核方法

以只读连接运行以下有界查询，可重新检查核心数据库对应关系：

```sql
SELECT count(*) AS outputs,
       sum(j.job_key IS NOT NULL) AS matching_jobs,
       sum(o.source_updated_at = j.input_watermark) AS matching_input_versions,
       sum(o.generated_at = j.finished_at) AS matching_completion_times
FROM stage1_outputs o
LEFT JOIN jobs j ON j.kind = 'memory_stage1' AND j.job_key = o.thread_id;

SELECT thread_id, source_updated_at, generated_at, rollout_slug,
       length(raw_memory), length(rollout_summary)
FROM stage1_outputs
WHERE thread_id = '01a0aa62-1091-7961-a883-c3e732fe548c';

SELECT id, ts, target, thread_id, length(feedback_log_body)
FROM logs
WHERE thread_id = '01a0adc6-d841-7b33-ac46-2a93664198da'
  AND id IN (56100898, 56102040, 56102048, 56110758, 56110761,
             56112801, 56115652, 56115654)
ORDER BY id;
```

`jobs` / `stage1_outputs` 与 `logs.ts` 使用秒；进入项目归一化字段时需转 Unix
毫秒。复核 body 时按这些主键读取，只提取 thread/turn、命令目标、patch hash 和
匹配计数，不公开 prompt、memory 正文或无关任务内容。
