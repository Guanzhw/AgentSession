# AgentSession 3.0 私有代表性 corpus 冻结记录

日期：2026-09-26。对应 2.0 基线 `50a32e7c5b3fdaa1d335771da80d6c919d4ab536`。冻结数据保存在忽略提交的 `tmp/v3-corpus/`；完整来源路径、会话 ID、五个可直接传给 CLI 的 provider root、来源事实、文件哈希、字节数、时间戳和 SQLite 版本只在 `manifest.private.json` 中。原始正文和私有标识不进入本文件。

## 来源映射与覆盖

样本先从隔离 2.0 基线的候选清单选出，再按实际 adapter 的路径、文件名和 canonical ID 规则核对：[Codex](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/providers/codex/adapter.ts)、[Claude Code](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/providers/claude-code/adapter.ts)、[Pi](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/providers/pi/adapter.ts)、[DSH](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/providers/deepseek-harness/adapter.ts) 与 [OpenCode](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/providers/opencode/adapter.ts)。文件副本保持 adapter 可发现的相对目录结构；DSH 同一会话的 v0 与 v3 压缩文件一起保留，当前 adapter 选择最高代 v3。OpenCode 使用只读源连接的 SQLite online backup，把 WAL 可见的事务纳入一致快照。

| Provider | 私有副本 | 已核实的覆盖 | 当前缺口 |
| --- | --- | --- | --- |
| Codex CLI | 2 个 JSONL，会话源合计约 27 MiB | 约 310/549 条基线消息的长会话候选；基线显示 compaction 与子 Agent 活动；副本分别解析出 9,126/4,694 条原始记录 | 本机 session tree 未发现 `.jsonl.zst`；718 MiB 活跃文件未选入；需用公开 fixture 或其他真实来源验证压缩路径 |
| DeepSeek Harness | 同一会话的 v0/v3 Zstd 代文件，另 1 个 descriptor 会话 | v3 解析出 3,251 条记录、v0 展开后 521,299 条记录；两代均有 3 次 compaction；另一会话有记录的 `subagent/descriptor` | 扫描当前 adapter 可发现的 20 条会话，未发现显式 `team/*` 或 `tool-workflow/*`；不得将旧版导出的 subagent 统计当作团队任务原始证据 |
| OpenCode | 1 个完整 SQLite v2 online backup | 151 条 session；候选长会话在快照内，含 279 条 `session_message`；`integrity_check=ok` | 快照内没有 `fork_session_id`，fork 语义需要其他真实来源或公开 fixture |
| Claude Code | 1 个 JSONL | 26 条原始记录，可验证基本转录读取 | 本机最长根会话仅约 8 条基线消息，不能证明长会话、compact 或 sidechain |
| Pi | 1 个 JSONL | 5 条原始记录，可验证基本转录读取 | 本机只有 1 条短会话；分支和 compact 需要其他真实来源或公开 fixture |

坏记录、缺失来源、JSONL 追加/重写/截断以及并发 WAL 变化是后续受控测试场景，不应由这些静态真实副本冒充。[公开 fixture 映射](agentsession-v3-public-fixture-map.md)列出已有可复用的测试输入与仍需补充的真实证据。每个 provider 现有真实副本或明确缺口；静态 corpus 的缺口不应被记成后续功能验收通过。

## 冻结与复核方法

`tmp/v3-baseline/selected-files.private.json`、`codex-size-candidates.private.json` 和 2.0 基线 API 提供本机选择依据。私有 `tmp/v3-corpus/freeze.py` 对文件来源进行 root、文件名和会话身份检查；在复制前后比较来源大小、mtime 与 SHA-256，并核对副本 SHA-256。OpenCode 的 `sqlite3.Connection.backup` 从 `mode=ro` 连接生成独立数据库，记录主文件/WAL 前后状态、`schema_version`、`user_version`、`data_version`，并验证快照表、会话数及 `PRAGMA integrity_check`。此轮备份时主文件/WAL 与 `data_version` 未变化。所有写入仅在忽略提交的 `tmp/v3-corpus/`。

在同一机器重新采集新时间点时，把私有采集脚本放入另一个忽略提交的 corpus 目录（脚本拒绝覆盖已有 `manifest.private.json`），将以下命令的目录前缀改为新目录：先运行 `python tmp/v3-corpus/freeze.py`，再运行 `node tmp/v3-corpus/scan-dsh.mjs`、`python tmp/v3-corpus/add-dsh-descriptor.py` 与 `node tmp/v3-corpus/enrich-manifest.mjs`，最后运行 `node tmp/v3-corpus/verify.mjs` 和 `python tmp/v3-corpus/smoke-corpus.py`。这会生成新的私有清单，不能把后续活动来源哈希当作原冻结值。当前 `verify.mjs` 对每个副本复算 SHA-256/大小，调用现有四个文件 adapter 的 parser，并用 OpenCode 存储检测及 SQLite 完整性检查确认数据库可读；结果写入 `verification.private.json`。全部 7 个文件副本和数据库通过；独立端口的 2.0 进程以冻结目录作为五个 provider root 启动，五个 provider 均可用，7 个目标会话 API 均返回 200（私有结果在 `smoke.private.json`）。一个 Codex 活动来源在采集后继续变化，其冻结副本哈希与采集时的双次来源哈希一致；后续来源漂移只记录为漂移。

私有 corpus 不提交、不包含在安装产物中。后续 2.0/3.0 对照应读取同一冻结目录，并使用各自隔离的 metadata/index/cache；若需补齐缺口，另建公开合成 fixture 或取得适当的真实样本，随后更新私有清单和本覆盖表。

## 2026-09-27 追加的 Codex 场景副本

原五-provider corpus 的 manifest 保持不变。另在忽略提交的 `tmp/v3-inherited-real-20260927/` 冻结一份 658,519-byte 的真实 Codex child JSONL：原始第 324 条是已记录的自有任务边界，边界前有 319 条 Reader 候选记录。固定 2.0 adapter 在此副本上返回 7 条继承消息、31 条自有消息，并能从 child 头部识别父引用；来源和副本的 SHA-256 在复制与 oracle 读取前后相同。它能检验真实归属，但不足以检验 40+ 条继承分页，后者仍用公开合成 fixture。

另在 `tmp/v3-exec-real-20260927/` 冻结一份 249,966-byte 的真实 Codex JSONL，包含一次外层异步 exec 挂起、一次按 handle 等待和完成。固定 2.0 adapter 返回 4 个执行事件，phase 顺序为 `started`、`yielded`、`polled`、`completed`；来源和副本哈希未变。它为后续 WEB-13/CORE-05 执行切片提供真实正例，不代表所有失败、终止与 direct-process 形状已覆盖。两份补充副本的完整路径、ID、哈希与私有 oracle 结果均只留在对应忽略目录，不进入发行包或公开测试文本。

WEB-05 另在 `tmp/v3-web05-three-level-20260927/` 冻结一条真实 Codex 父→子→孙链，三个来源文件合计 765,131,795 bytes，分别含 81,428／1,809／222 条完整 JSONL 记录且无坏行。扫描 972 个本机普通 JSONL 头部找到 8 条三层链；这条是两条边均有原生 child-ID 来源锚点的最小一条。固定 2.0 adapter 核对了三个 canonical 身份、两条 parent 关系、两处显式且可用的挂载位置。两处 `parentPartId` 都来自 `spawn_agent` 的 `response_item/function_call` call ID 加 `:tool`；相邻 `SubAgentActivity` item ID 与 call ID 相同。2.0 Reader 的显式链接由 `function_call_output` 中的 `task_name` 与子会话 `agentPath` 别名匹配，不能把事件 ID 匹配误称为挂载依据。三个会话各有 2,687／94／15 条自有 Reader 消息；原始与冻结来源在核对后 SHA-256 均不变。私有 manifest/oracle 只保留在忽略目录。该样本可用于选择性真实 WEB-05 验收；由于体量大，日常 RED/GREEN 使用同形的公开小 fixture，不能把 2.0 adapter 观察当作 3.0 浏览器已通过。

## 受控 Viewer 元数据种子

`scripts/v3-build-metadata-seeds.mjs` 从上述只读 metadata 在线备份与私有目标清单生成四个忽略提交的数据库：仅有 Viewer 元数据表的功能对照种子、保留旧派生表的升级/回退种子，二者各有隐藏会话恢复前后状态。它们覆盖五 provider 的 canonical 键、收藏/自定义标题、软隐藏、永久排除、provider 相同 ID 的不同元数据行，以及 OpenClaw/Hermes 已保存行。升级种子还保留原备份的 1,064 条旧 `session_index` 行，其中包含退役 provider；功能种子不混入旧索引。所有新增标题/标记为受控合成值，原备份未改动。

四份数据库位于 `tmp/v3-corpus/metadata-seeds/`，大小与 SHA-256 收录在私有 `frozen-capture-record.private.json`。生成器拒绝覆盖已有目录，并在复制前后核对原备份哈希；公开合成测试核对表隔离、原用户行、状态组合、恢复以及退役索引保留。它们是后续 HTTP-08/09、CORE-01/13、MCP-08、DEL-05 的**输入**，不是 3.0 迁移、回退或来源范围隔离已通过的证据。
