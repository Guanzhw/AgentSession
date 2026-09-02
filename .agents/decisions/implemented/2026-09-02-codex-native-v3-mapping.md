---
status: implemented
date: 2026-09-02
decision: Map Codex recorded session evidence into Session Protocol v3 native facts (goals, actors, coordination, context versions/transformations, usage records) through a provider-native v3 snapshot, while preserving all finalized v2 facts.
---

# Codex native Session Protocol v3 mapping

## Context

The v3 foundation, projections, and Work Graph-first detail page are implemented;
every provider still degrades truthfully to v2 facts with all v3 domains unknown.
Research (`docs/specs/work-graph-protocol/evidence-matrix.md`) ordered Codex first
because live data proves continuing subagent coordination, compaction lineage, and
request usage. This change maps the Codex CLI rollout records observed locally on
`01a0576a-98e2-7c31-a265-6d98d5fbff12` (Codex `0.151.0-alpha.7.2`):

- `event_msg/thread_goal_updated` records `{threadId, goal:{objective, status,
  createdAt, updatedAt, ...}}` — recorded goal lifecycle (statuses observed:
  `active`, `paused`).
- `response_item/function_call` records in the `collaboration` namespace name the
  native subagent tool family: `spawn_agent`, `followup_task`, `send_message`,
  `wait_agent`/`wait`, `list_agents`, `interrupt_agent`; sibling
  `function_call_output` records carry `call_id`; `internal_chat_message_metadata_passthrough`
  carries `turn_id` on some calls. `list_agents` is a mailbox query, not a
  coordination fact.
- `response_item/agent_message` envelopes carry `author` and `recipient` agent
  paths and `Message Type: FINAL_ANSWER` bodies — recorded result delivery from
  child agents to the parent. Child session identities bind through the existing
  v2 task/run/relationship normalization.
- `compacted` records carry `window_id`, `previous_window_id`, `first_window_id`,
  and `window_number`. Ten contiguous records form a linear window chain with no
  gaps (window 1..10), so compaction is a recorded context transformation between
  recorded context versions; the earliest recorded window is the initial
  context version.
- `event_msg/token_count` records carry `info.last_token_usage` with Codex token
  components where `input_tokens` includes cached/cache-write tokens and
  `output_tokens` includes reasoning. Each record is one changed request; the
  persisted record identity is its `ordinal`.
- The parent's own agent identity is not in `session_meta.agent_path`; it is the
  recorded `recipient`/`author` path (`/root`) of the agent-message envelopes.

## Decision

Add an optional adapter accessor `getSessionProtocolV3(sessionId)` returning a
provider-native finalized v3 snapshot; the runtime v3 boundary uses it when
present and otherwise keeps the v2-to-v3 upgrade. Codex implements it as a
derivative of the finalized v2 snapshot (v2 facts preserved verbatim, same
session descriptor and revision) plus native v3 facts:

- **Goals**: one Goal per recorded thread goal (`threadId`), description =
  recorded objective, status mapped `active → active`,
  `completed/failed/cancelled → same`, `paused → unknown` (no protocol status
  means "user-suspended" and semantics must not be invented); recorded
  timestamps in ms. No goal/task link is recorded; `taskIds` stays empty.
- **Actors**: one agent actor per recorded agent path — the session's own path
  (recorded `session_meta.agent_path` first, then the agent-message recipient
  evidence, e.g. `/root`) and each direct child's recorded agent path; child
  actors carry `sessionRef` and the child run id. Extra author/recipient paths
  that appear in recorded envelopes become actors too (provenance recorded);
  actor identity is the path.
- **Coordination** (typed from the collaboration family, recorded provenance,
  `eventId` unset when the v2 event id space cannot prove the anchor, call id
  preserved in `correlationId`):
  - Matching is restricted to the `collaboration` namespace: same-named tools
    outside it (cell `wait`, `exec`, mailbox queries) never produce
    observations.
  - `spawn_agent` → `spawn`, state `started` when a child rollout binds through
    the v2 task/run normalization or a matching output record exists, else
    `requested`; `toSessionRef` set when the child session is bound. Binding
    prefers the exact call id, then exact agent path, then the path's
    task-name suffix with a single candidate; ambiguous matches stay unbound.
  - `followup_task` → `follow-up`; `send_message` → `message`;
    `wait_agent`/`wait` → `wait`; `interrupt_agent` → `interrupt`. State is
    `unknown`: the call records the request, not delivery or completion.
  - FINAL_ANSWER envelopes from a child → `result-delivery`, state `delivered`,
    sender/recipient bound to the resolved actors and source session refs, with
    the recorded pass-through `turn_id` when present. Self-authored envelopes
    (author == recipient) are not result delivery.
  - `list_agents` and `exec` are not coordination facts.
- **Context**: one version per recorded `window_id` (and the initial recorded
  window), linear `parentVersionIds` from `previous_window_id`; one
  `compaction` transformation per compacted operation with source/result
  version ids and the existing v2 summary artifact as the observed
  metadata-only result (ids matching the v2 event/artifact ids).
- **Usage**: one request record per `token_count` event, id
  `usage:<session>:<ordinal>`, tokens normalized to the v3 component contract
  (`input` = uncached input, `cacheRead`, `cacheWrite`, `output` = non-reasoning
  output, `reasoning`, `total` = recorded total; components of included records
  sum exactly to the recorded total), model from the nearest recorded
  `thread_settings_applied` (derived provenance), no origins — Codex does not
  record request context origin slices. `token_count` records whose components
  are all zero are window-reset markers (context size in `total`, same
  timestamp as a compaction), not model requests, and are excluded.
- **Coverage** per focus session: `observed` when the domain has facts,
  otherwise `not-observed`, with details naming the recorded source shapes;
  `unsupported`/`unknown` are never inferred.

## Alternatives considered

- Extend only the v2 builder and keep upgrade-time synthesis. Rejected: v3
  facts are recorded evidence, not projections of v2 entities; the upgrade
  boundary explicitly must not synthesize them.
- Reuse `upgradeSessionProtocolV2` with `coverage` overrides and treat v3 facts
  as a provider-side overlay in `getRuntimeProtocolV3`. Rejected: the adapter
  contract stays the single normalization boundary, and a native snapshot keeps
  validation/freeze semantics identical to other snapshots.
- Map `paused` goal status to `blocked`. Rejected: user suspension is not the
  protocol's blocked semantics; unmapped statuses stay `unknown`.
- Assign `eventId`/`turnId` anchors by timestamp correlation. Rejected: only
  recorded anchors (`turn_id` passthrough, call ids) are used; the v3 dangling
  checks must not see invented anchors.
- Report per-request model as null. Rejected: the nearest recorded
  `thread_settings_applied` is recorded evidence and yields the exact recorded
  model at that point; absence is not claimed when a record exists.

## Consequences

Codex Work Graph domains switch from `unknown` to observed typed facts for goals,
coordination, context lineage, and request usage while all v2 facts and the v2
Runtime API remain unchanged. `paused` goals display as unknown status until a
protocol status exists. Unmapped evidence (`list_agents`, encrypted task bodies,
request context origins) stays explicit and uninvented. Other providers keep the
truthful v2 upgrade path unchanged.

## Verification

- Focused fixtures and regression tests in `test/codex-v3.test.mjs` cover
  active/paused goals, the collaboration call family, FINAL_ANSWER result
  delivery (including the self-envelope exclusion), the linear window chain,
  token_count normalization, coverage states, and the runtime native-v3 cache
  path; the v3 validator asserts zero errors on every fixture.
- `npm run build`, `npm test` (317 passing, including all pre-existing v2
  protocol/runtime/QA suites), `npm run review` (governance + TypeScript), and
  `git diff --check` pass.
- Real-data checks on
  `/api/codex/session/01a0576a-98e2-7c31-a265-6d98d5fbff12/runtime/{work,execution,coordination,context}`
  report `completeness: complete` with zero diagnostics: Work 1 goal/13 tasks,
  Execution 13 runs/14 actors, Coordination 158 observations (spawn bound to
  child session, run, turn id, recorded provenance; non-collaboration `wait`
  and `exec` excluded), Context 10 artifacts / 11 versions / 10 transformations,
  Usage 1,135 request records (10 window-reset markers excluded) with components
  summing to the recorded totals; every domain coverage is observed with
  recorded source-shape details.
- The SSR Work Graph detail page renders the native facts; browser QA passed
  Work Graph default tab, Conversation navigation, tool calls, and transcript
  search. The deep-ToC assertion cannot be exercised by any current local
  OpenCode session (the only session with subagent runs has 3 messages and no
  tool calls; other sessions expose no nested ToC — confirmed by DOM probe);
  this is a fixture-availability limitation, not a regression: the change
  touches no OpenCode/ToC/static code.
- Independent review of the mapping against the recorded shapes found one P0
  (non-collaboration `wait` mapped with fabricated collaboration provenance)
  and two P1 (window-reset markers reported as zero-component requests;
  suffix-heuristic binding precedence). All three are addressed in this
  change: namespace-restricted matching, marker exclusion, and
  exact-identity-first binding with ambiguity left unbound; P2 items
  (actor provenance branch, turn anchors on result delivery, cache revision
  guard, LRU-style eviction, single input load, test gaps) are addressed too.

### Follow-up verification (bounded review fixes)

A follow-up review found the native v3 cache hit path and the FINAL_ANSWER
self-envelope exclusion did not match the decision above, and both are now
tested and fixed:

- **Native v3 cache is now LRU on hit.** The v3 native cache hit path
  previously returned without refreshing recency (FIFO eviction); it now
  deletes + re-sets the key on hit, so overflow eviction removes the true
  least-recently-used entry. Regression test `native v3 cache evicts the true
  LRU entry after a hit refreshes recency` fills the 256-entry cache, refreshes
  one entry, overflows, and asserts the refreshed entry survives while the
  actual LRU is evicted. The revision checksum and `MAX_CACHE_ENTRIES` bound are
  unchanged; the no-revision provider path is untouched.
- **Self-authored FINAL_ANSWER exclusion now matches the decision.** The
  exclusion previously required both `author` and `recipient` to equal the
  resolved parent path; it now excludes every envelope with `author ===
  recipient`, matching the recorded "self-authored envelopes" rule. Regression
  test `Codex v3 excludes self-authored FINAL_ANSWER envelopes regardless of
  parent path` covers an unresolvable parent path and a parent path that
  resolves elsewhere, and asserts the genuine child→parent delivery is still
  emitted.
- Commands run for the follow-up: `npm run build` (clean), `npm run review`
  (governance + TypeScript, clean), `git diff --check` (clean), focused
  `test/codex-v3.test.mjs` + `test/protocol-runtime*.test.mjs` (all pass),
  and `npm test` (326/327; the single failure is the pre-existing
  `provider-removal.test.mjs` Windows-path fixture, which fails identically
  on the pre-change tree because `C:\...` paths are not absolute under the
  WSL/POSIX test environment — unrelated to this change). Both new tests
  fail against the pre-fix code and pass after the fix.

### Portability and cache revision follow-up (bounded review fixes, round 2)

The 326/327 WSL/POSIX result above was how the portability fixture was
**discovered**, not a product regression: `provider-removal.test.mjs` is a
retired-config cleanup test and used hard-coded `C:\...` paths that are not
absolute under WSL/POSIX. That fixture is now fixed in this follow-up: all
paths are derived from the test's temp directory as cross-platform absolute
path variables (CLI args and assertions updated accordingly);
`src/config.ts` is untouched and absolute-path validation is not weakened.
The focused test passes 1/1 on the current WSL/POSIX environment.

- Main agent verified on Windows native: `npm test` 327/327, `npm run review`
  pass, `git diff --check` pass (state before this round's test additions).
- This round (WSL/POSIX, after the fix): `npm run build` clean, focused
  `test/protocol-runtime.test.mjs` + `test/codex-v3.test.mjs` 22/22, focused
  `test/provider-removal.test.mjs` 1/1, `npm test` 329/329 (2 new shared
  cache revision tests added), `npm run review` (governance + typecheck)
  pass, `git diff --check` clean. No commit or push performed.
- The shared native v3 cache revision fix is recorded separately in
  `.agents/decisions/implemented/2026-09-03-session-protocol-v3-cache-revision.md`;
  the Codex provider-owned mapping in this record is unchanged by it.

