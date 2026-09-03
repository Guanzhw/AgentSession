# 后端演进 · 任务 A:bounded usage-origin 记账(核心)

```text
任务:让 UsageRecord 的 origin slices(direct/inherited/shared)从"规格有、投影不暴露"
变成"有界记账":投影侧暴露 origin 聚合(有证据给值,无证据如实 null/缺省),
保持 additive 不重复计数与 coverage 语义;若某 provider 存在来源切片证据,
再按 provider-native v3 映射模式填值。这是 token ownership 主目标的核心。

**状态(2026-09-03):投影部分已完成,provider 映射保持 evidence-pending。**

- 已落地:Execution `usage.origins` 有界聚合(每组件 total/classified 已知下界/
  unclassified/complete + inspectedRecords/recordsTruncated/slicesTruncated),
  与现有 usage 权威总量/usageRecords 共用同一被投影 record 集合;构造有界
  (slice 扫描受 maxItems 限制、不枚举 source refs、不把 contextOriginSlices
  放回 public usageRecords);决策记录
  `.agents/decisions/implemented/2026-09-03-bounded-usage-origin-accounting.md`。
- 审计结论(2026-09-03 snapshot 限定):七 provider(OpenCode/Claude Code/Codex/
  OpenClaw/Hermes/Pi/DSH)对**当时 adapter/fixtures/本地已验证快照**均无"每次请求
  input/cache token 的来源切片"证据——Codex 在 0.151 alpha 样本确认没有;
  DSH 的 seedLength/inheritedEventCount/owned suffix 是继承边界,不是
  request token origin slice,不强行映射;因此**未写任何 provider-native 映射**;
  OpenClaw 最新 SQLite、DSH alpha.5、Pi 0.84.4 已通过 2026-09-03 的 refresh
  完成确认(官方 snapshot/源码/真实数据均无 request origin slice),其余上游新版本
  未 refresh,slice 状态 pending/unknown,不得作为"无 slice"证据。
  审计结论写入 `docs/specs/work-graph-protocol/evidence-matrix.md` →
  "Usage origin slice audit"。

当前状态(HEAD):Codex native v3 映射已实现——usage 记录有归一化组件,但
Codex 明确不记录 request context origin 切片(见
.agents/decisions/implemented/2026-09-02-codex-native-v3-mapping.md);
有界 Execution/Usage 投影已暴露 origin 聚合。本任务不能因"无 provider 证据"而搁置
投影侧交付,也不能在无证据时让 UI 显示三分。

步骤:
1. ✅ 重读 work-graph-protocol/design.md §Request usage(切片语义、sum 上限、cache 不去重)
   与 §Bounded projection API(Execution 返回 additive usage 与 coverage 的现状),
   以及 2026-09-02-codex-native-v3-mapping 决策记录的 Usage 部分;
2. ✅ 证据调研(只依据记录证据,不推导):Codex 已确认不记录;DSH 的 inheritedEventCount
   是种子/继承边界,不等于 input token 的 origin 切片;OpenCode/Claude/Pi/OpenClaw/
   Hermes 逐一确认没有"请求上下文来源"记录,结论写入 evidence-matrix
   → "Usage origin slice audit (2026-09-03)";
3. ✅ 投影侧(独立于 provider 填值):Execution/Usage 投影响应暴露 origin 聚合——
   有证据给值,无证据如实 null/缺省,保持 additive 不重复计数与 coverage 语义;
   实现见 `src/protocol-runtime-v3.ts` `UsageOriginAggregate`;
4. (待真实证据)若某 provider 证据成立,按 codex-native-v3-mapping 记录的模式扩展其
   native v3 usage 映射,写 fixtures 与测试(test/codex-v3.test.mjs 模式);
   本次审计确认无 provider 具备该证据,故未写映射;
5. ✅ 更新 work-graph spec Evolution backlog 第 1 项状态(投影已实现/待 provider 证据),
   新建 implemented 决策记录 2026-09-03-bounded-usage-origin-accounting;
   同步 docs/design/ui-v2.md §7 该行与本目录 README;
6. ✅ 验证:npm run build && npm test && npm run review && git diff --check;真实数据检查
   /api/codex/session/01a0576a-98e2-7c31-a265-6d98d5fbff12/runtime/execution 的
   usage.origins(当前预期:recordsTruncated/slicesTruncated=false、classified 零下界、
   complete=false,不显示伪三分)。

完成动作:交独立 pi_review 只读审查(范围/证据有界);主 agent 汇总验收。
```
