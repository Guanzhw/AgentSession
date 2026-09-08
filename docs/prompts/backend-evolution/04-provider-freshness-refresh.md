# 后端演进 · Provider evidence freshness refresh(下一阶段 bounded spec)

```text
任务:按照 evidence-matrix 的 2026-09-03 freshness snapshot,逐 provider 刷新
parser/schema/protocol 映射,把"所有 provider 都会演进,必须维护最新 provider
文档"落实为可执行流程。本文件是**下一阶段的有界 spec,不是立即实现**。

**状态:规划中(bounded spec,不落地代码)。** 当前 adapter 快照已落后于多个
upstream 版本;refresh 必须逐 provider 独立进行(单独决策/fixture/真实数据/提交),
不做大爆炸式一次性重构。任何 parser/protocol 变更前,先满足证据门槛:
官方 docs + upstream source + 本地真实记录三方面证据齐全,并按
docs/CONTRIBUTING-PROVIDER.md 「Provider evidence freshness」规则记录
verified-at、版本/commit、官方来源链接与样本格式。

刷新优先级（用户明确要求跟最近版本的 DSH 与 OpenClaw 先行）：

1. **DeepSeek Harness alpha.5** — ✅ **已完成（2026-09-03）**。upstream HEAD
   49a606bc5b5934603f22a26957a07dc799ab0291, alpha.5 tag
   db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5。证据：官方 alpha.5 checkout
   源码 + 官方检查入库 web snapshot（byte-identical, sha256
   07473442…）+ npm 安装 0.1.2-alpha.5。结论：物理存储格式与 alpha.3
   相同（version 0、同一 event catalog、seedLength 头部行、packed rows、
   range-encoded provenance），无需 parser/protocol 变更；新增
   `.agents/decisions/implemented/2026-09-03-dsh-alpha5-compatibility-snapshot.md`
   与 alpha.5 官方快照 fixture/回归。限制：credentialed live run 不可用
   （key auth 失败），未产生新的 live 证据（已显式记录，不当作成功）。
2. **OpenClaw current SQLite** — ✅ **已完成（2026-09-03）**。官方 HEAD `f92a12c5…` 与 release `v2026.8.2` 的 agent schema SQL 字节一致（sha256 `54fa65dc…`，agent schema 19；最新 main `2d9796d6…` 仅 package.json 元数据差异）。实现：`src/providers/openclaw/sqlite-store.ts` 只读快照读取 `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`（`session_nodes` canonical key、`session_windows` 代数、`transcript_events` 原始事件），复用现有 JSONL record parser；legacy JSONL 保留可读并按 canonical session 与 SQLite 去重（SQLite 恰好一次）；诊断区分 current/legacy-only/unsupported/unreadable。决策记录：`.agents/decisions/implemented/2026-09-03-openclaw-current-sqlite-coexistence.md`。限制：本机安装 2026.7.1-2 为 pre-flip、无当前格式数据目录，真实本地数据验证未完成（显式记录）。
3. **Pi current v3 / 0.85.1** — ✅ **已完成（2026-09-08）**。官方当前包为
   @earendil-works/pi-coding-agent npm 0.85.1，package tag/gitHead
   `d981de12…`；独立官方源码 HEAD 为 `f53ac113…`。当前安装 0.80.10，暂无
   live 0.85.1 transcript。官方 session format 仍为 v3；reader 保留 finalized
   v2 facts，并按 canonical assistant request 发出 bounded Usage，按可读的
   `branch_summary`/compaction summary 发出 Context version/transformation。
   当前官方 context 边界是 `firstKeptEntryId`；`retainedTail` 降为
   historical/harness extension evidence，不作为当前标准字段。provider
   metadata 仅把 `stopReason=deferred` 标为 terminal，官方 `pending` 保持
   非终态。旧 0.84.4 证据保留在独立历史决策记录中；49 个嵌套
   `run-N/session.jsonl` 为 pi-subagents 产物（`parentSession` null，不虚构
   lineage）。决策记录：`.agents/decisions/implemented/2026-09-08-pi-native-v3.md`。
4. **Codex CLI 0.152.1 → 0.153.0** — ✅ **已完成（2026-09-03）**。本机
   `codex --version` 为 0.152.1；官方 `openai/codex` release
   `rust-v0.153.0`（release tag peeled commit `41e22fee981a63b3698df7ed36bad393cda24715`）与
   HEAD `36984da4424cb91b6bc88c6af8d73207930ac729` 已核验。当前 HEAD
   rollout source 新增 `.jsonl.zst`、
   `token_usage_record`、仅进入 Runtime v3 的 `inter_agent_communication` 和 v1
   `multi_agent_v1/close_agent`；本机 0.152.1 真实样本仍是 `token_count` + collaboration
   response items，并含 `inter_agent_communication_metadata`。实现：Codex
   parser/protocol 支持 plain/compressed rollouts、per-response usage、
   first-class communication（不进入线性 transcript），以及把 close 归一为
   `interrupt`；明确成功/失败/模糊/缺失输出分别保留对应状态；累计
   `turn_token_usage`/`thread_token_usage` 不会被重复计数。新增
   `test/fixtures/codex-current-v153.jsonl`（source-derived bounded synthetic fixture，非 live capture）与压缩读取回归，决策记录见
   `.agents/decisions/implemented/2026-09-03-codex-current-compatibility.md`。
   限制：本机尚未安装 0.153.0，真实 0.153 rollout 仅由官方 source 与
   有界 fixture 覆盖；本机最新 0.152.1 样本已做只读 parser/protocol smoke。
5. **Claude Code 2.1.263** — 本机安装 2.1.207；npm `latest`/`next` 为
   2.1.263，`stable` 为 2.1.236。官方仓库 `HEAD` 与 release tag `v2.1.263`
   均为 `ab9b2cf7bb9e4f98ff264c07a22e46d83c29c558`（2026-09-08）；已区分
   npm dist-tag、release tag 与源码 HEAD。官方文档确认 project-scoped
   JSONL、subagent `system`/`compact_boundary` 与
   `compactMetadata.preTokens`；adapter/protocol 已补齐该有界 compaction
   证据与 `cache_creation` 对象 fallback；Anthropic total input 按
   `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`，
   `output_tokens` 拆分为 visible output/reasoning 且不重复计费，保持
   metadata-only，不污染线性 transcript。真实本机快照 11 个 project
   transcript / 132 records，无
   sidechain、task-notification 或 compaction；已做只读 adapter/protocol
   smoke。测试新增 4 个 focused 回归；fixture 为
   source-derived bounded synthetic fixture，非 live capture。native v3 以同一 finalized
   v2 snapshot 为基底，按 canonical assistant response id 去重 request Usage，保留
   缺失 tool-use-id 的 task notification，并将 stopped 映射为 cancelled；决策记录见
   `.agents/decisions/implemented/2026-09-08-claude-code-native-v3.md`。当前 2.1.263
   结论为 docs/upstream-verified；本机没有 live 2.1.263 transcript。
6. **OpenCode 1.18.29** — npm `opencode-ai` latest 1.18.29；本机安装
   1.17.11(Windows)。官方 release tag `v1.18.29` 为
   `16747470f976aca3d362ad730bcd3fe82ecc2c9a`，官方源码 HEAD 为
   `ecbc6ccac85b3e8087b6445e584318419b9e2b34`；1.18.27→1.18.29 的相关
   session/tool schema 无变化。官方
   schema 保留 `message`/`part` 投影，并记录 `todo`、task subtask/compaction
   part 与 task 工具的 background/job 状态；适配器已补 todo Task、
   subtask/compaction 事件和 background 状态。真实本机库只读快照为 131
   sessions/73 parent links/182 todos/2,968 messages/13,091 parts，context
   epoch/input 均为 0；回归使用 bounded synthetic shape，不复制真实 body。
   todo source key 为 `(session_id, position)`，Task identity 保持 snapshot-local，
   不从可变内容推导跨重排连续性；compaction tail 仅在对应 message存在时建立 anchor。
   官方 Todo status 文档值为 pending/in_progress/completed/cancelled，未知值
   显式跳过，不伪造状态。synthetic fixture 使用官方
   `CompactionPart(type/auto/overflow/tail_start_id)`、
   `SubtaskPart(type/prompt/description/agent/model/command)` 与 task
   `state(title/metadata/output)` 的 bounded keys，文件为
   `test/fixtures/opencode-current-v1.18.27-synthetic.jsonl`，非 live capture；
   当前 native-v3 focused 回归为 7/7，完整 `npm test` 为 467/467。
7. **Hermes Agent v0.21.1 / v2026.9.7** — ✅ **已完成（2026-09-08）**。
   本机安装/本地源码为 v0.19.1 (`840fb55a8aaeb69bfcd6f34a80e57f9a5bcd44ce`)；
   官方 release source commit 为
   `2237be355906fbe6065ce1815711eee52b2d646e`，另行核验的官方源码 HEAD
   为 `6e2b8e070d28b1a3381a3fb290b6b8d6cce13cef`，两类 provenance 已分开。
   官方 `hermes_state_common.py`/`tools/async_delegation.py` 当前 schema marker
   为 30；async registry 的 `parent_session_id` 是持久化 spawner，当前
   `origin_session_id` 是 API completion wake target，`origin_session` 是旧 CLI
   session-key fallback。后两者不得混同为同一种 canonical owner。
   当前 source/state schema 证据含 `messages.active`/`compacted` 与
   `async_delegations` handle/state/delivery 字段；adapter 在 store 边界只读
   active transcript，压缩只生成 metadata-only context evidence，并将有记录的
   async delegation 映射为 background Task；若另有 persisted child，则单独映射
   为无 taskId 的 AgentRun。native Session Protocol v3 在同一 finalized v2
   snapshot 上分离 dispatch/lifecycle/delivery observations；聚合 token 保持
   `unknown` usage coverage，不伪造 request usage。未知状态、缺 owner、无 child
   session、memory/experience/team/handoff/continuing interaction 均保留 unknown；
   不推断 inherited/shared ownership 或 handle→child correlation。新增
   `test/fixtures/hermes-current-v0210-synthetic.json`（schema 30、source-derived
   bounded synthetic，非 live capture）与 focused 回归；决策记录见
   `.agents/decisions/implemented/2026-09-08-hermes-native-v3.md`。

纪律:
- 每个 provider 独立决策记录、独立 fixtures、独立真实数据验证、独立提交;
  一个 provider 的 refresh 不阻塞也不依赖其余 provider。
- 只在官方文档 + source + 真实记录证据后改 parser/protocol;负面结论只对该
  快照成立,格式漂移显式标记 supported/legacy/pending;禁止自动升级用户安装、
  禁止写 provider 数据。
- 保持核心 Work Graph provider-native v3 mapping 的优先级:本 refresh 是
  "证据时效"维护,不改变 v3 映射的设计与实施顺序;若与核心 v3 映射冲突,
  以核心 v3 映射为准,refresh 推迟。
- 每完成一个 provider:更新 evidence-matrix freshness snapshot 对应行
  (verified-at/版本/来源/样本),同步 README.md 与 README.en.md 的
  provider 表与兼容段。

完成动作:每个 provider 完成后由独立 Luna reviewer 只读审查(范围/证据有界);
主 agent 汇总验收;git diff --check + npm run check:governance。
```
