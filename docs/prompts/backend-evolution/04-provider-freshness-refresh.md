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
3. **Pi current v3 / 0.84.4** — ✅ **已完成（2026-09-03）**。官方当前包/源为
   @earendil-works/pi-coding-agent → npm 0.84.4（2026-08-28 发布，tag
   `b79e4cc8…`）与 https://github.com/earendil-works/pi-mono（官方
   `docs/session-format.md` 引用；`earendil-works/pi` 原仓库 URL 可解析到同一
   HEAD），HEAD `4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057`（2026-09-02）。
   当前安装 0.82.1（本机 547 个真实文件全部 version 3）。v3 = v2 + `message.role
   "hookMessage"` → `"custom"` 重命名；其余 entry 类型（custom/custom_message/
   model_change/thinking_level_change/compaction/branch_summary/label/
   session_info）与 v2 相同。实现：reader 映射 custom 角色 message 条目
   （display 门控，与 custom_message 一致）、protocol 记录 retainedTail/
   fromHook 证据（不展开 retainedTail 为独立消息）、token 总量纳入已记录
   toolResult/compaction/branch_summary usage（对齐官方 billed session total
   `getSessionStats`/`usage-totals.js`：全部记录条目，含 abandoned/history
   分支，retainedTail 副本不重复计）。
   旧 @mariozechner/badlogic 信息只能标 legacy，不得作为最新源。限制：本机
   数据无 role custom/retainedTail/toolResult-usage 记录，官方源码/文档 + 新
   fixture 覆盖（显式记录）；49 个嵌套 run-N/session.jsonl 为 pi-subagents
   产物（parentSession null，不虚构 lineage）。决策记录：
   `.agents/decisions/implemented/2026-09-03-pi-v3-current-compatibility.md`。
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
5. **Claude Code 2.1.259** — 本机安装 2.1.207；npm `latest`/`next` 为
   2.1.259，`stable` 为 2.1.236。官方仓库 `HEAD` 与 release tag `v2.1.259`
   均为 `f173a697aa6486945f1b9c4aa9ce5383d2c87db6`（2026-09-03）；已区分
   npm dist-tag、release tag 与源码 HEAD。官方文档确认 project-scoped
   JSONL、subagent `system`/`compact_boundary` 与
   `compactMetadata.preTokens`；adapter/protocol 已补齐该有界 compaction
   证据与 `cache_creation` 对象 fallback；Anthropic total input 按
   `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`，
   `output_tokens` 拆分为 visible output/reasoning 且不重复计费，保持
   metadata-only，不污染线性 transcript。真实本机快照 11 个 project
   transcript / 132 records，无
   sidechain、task-notification 或 compaction；已做只读 adapter/protocol
   smoke。当前 2.1.259 结论为 docs/upstream-verified；本机没有 live
   2.1.259 transcript。测试新增 4 个 focused 回归；fixture 为
   source-derived bounded synthetic fixture，非 live capture。决策记录见
   `.agents/decisions/implemented/2026-09-03-claude-code-current-compatibility.md`。
6. **OpenCode 1.18.27** — npm `opencode-ai` latest 1.18.27；本机安装
   1.17.11(Windows)。官方 release tag `v1.18.27` 为
   `4b7e19e315cca414121ba1d61523fef74bb3ae8b`，官方源码 HEAD 为
   `b578b7261fc9ec4917fe272df5cc4bd8a056cd5d`，二者证据分开记录。官方
   schema 保留 `message`/`part` 投影，并记录 `todo`、task subtask/compaction
   part 与 task 工具的 background/job 状态；适配器已补 todo Task、
   subtask/compaction 事件和 background 状态。真实本机库只读快照为 131
   sessions/73 parent links/182 todos/2,968 messages/13,091 parts，context
   epoch/input 均为 0；回归使用 bounded synthetic shape，不复制真实 body。
   todo 没有独立 row id，Task identity 使用稳定字段 fingerprint，不把可重排
   position 当作唯一身份；compaction tail 仅在对应 message 存在时建立 anchor。
   官方 Todo status 文档值为 pending/in_progress/completed/cancelled，未知值
   显式跳过，不伪造状态。synthetic fixture 使用官方
   `CompactionPart(type/auto/overflow/tail_start_id)`、
   `SubtaskPart(type/prompt/description/agent/model/command)` 与 task
   `state(title/metadata/output)` 的 bounded keys，文件为
   `test/fixtures/opencode-current-v1.18.27-synthetic.jsonl`，非 live capture；
   最终 focused OpenCode/SQLite 回归为 3/3，完整 `npm test` 为 369/369。
7. **Hermes Agent remote HEAD** — 1cb3ab617363ffab9e55239a7d2ab0d6f9c10473;
   本地 v0.19.1(upstream 0cd26ce9 / local 840fb55a)的 state.db 结论只对已验证
   版本/本地样本成立。

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

完成动作:每个 provider 完成后独立 pi_review 只读审查(范围/证据有界);
主 agent 汇总验收;git diff --check + npm run check:governance。
```
