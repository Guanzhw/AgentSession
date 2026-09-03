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
3. **Pi current v3 / 0.84.4** — 官方当前包/源为 @earendil-works/pi-coding-agent 与
   https://github.com/earendil-works/pi,HEAD e266507b606b9552fa277252644054afd4384b11;
   当前安装 0.80.10,官方 session format 为 v3。旧 @mariozechner/badlogic 信息只能标
   legacy,不得作为最新源。现有 reader 需针对 v3/当前版本持续验证。
4. **Codex CLI 0.152.1** — installed/npm 0.152.1,HEAD
   5e26f7621c1c470fe62350d61c9eb4d6c772a0da;现有 native-v3 验证样本(0.151 alpha)
   是历史快照,不等同最新版本已覆盖。
5. **Claude Code 2.1.258** — npm 2.1.258,repo HEAD
   aef74afe01f65b602258d6102b0da9730ac6f0aa;本机安装 2.1.207。
6. **OpenCode 1.18.26** — npm opencode-ai 1.18.26;本机安装 1.17.11(Windows)。
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
