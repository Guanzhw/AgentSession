---
status: implemented
date: 2026-09-03
decision: Refresh the Pi reader to the official current session format v3 / npm 0.84.4 snapshot: map custom-role (v3, formerly hookMessage) message entries display-gated, record retainedTail/fromHook compaction evidence, and include recorded toolResult/summary usage in token totals — without inventing tasks, agent runs, or origin slices.
---

# Pi v3 current-format compatibility (0.84.4 / pi-mono HEAD 4e69b0c2)

## Context

`docs/prompts/backend-evolution/04-provider-freshness-refresh.md` scheduled Pi
current v3 / 0.84.4 as the next provider-freshness stage after DSH alpha.5 and
OpenClaw current SQLite (both completed 2026-09-03). The reader snapshot was
pinned to v3 in name only: no evidence refresh had been recorded, and the
official upstream references (repo URL, HEAD) were stale in the docs.

## Evidence (verified 2026-09-03)

- **Package**: `@earendil-works/pi-coding-agent` npm `latest` = **0.84.4**
  (published 2026-08-28T22:07:57.753Z), tag `v0.84.4` =
  `b79e4cc834970cca69daebffab7df1da7d1e52c4`. Same 0.84.4 tarball unpacked and
  inspected at `/tmp/pi-0844/package`.
- **Repo**: official `docs/session-format.md` and source links point to
  <https://github.com/earendil-works/pi-mono>; HEAD =
  `4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057` (2026-09-02T21:39:29+02:00),
  identical to `earendil-works/pi` HEAD (repo reachable under both URLs).
  Docs previously recorded HEAD `e266507b…` — stale, refreshed.
- **Format**: `CURRENT_SESSION_VERSION = 3` in the 0.84.4 source
  (`dist/core/session-manager.js`); migration `migrateV2ToV3` is exactly one
  change: `message.role === "hookMessage"` → `"custom"` (v1→v2 adds
  id/parentId + `firstKeptEntryId`; v2→v3 is the role rename only). Official
  `docs/session-format.md` (v3) documents the full entry catalog and the
  optional compaction fields: `usage` (summary-generation usage, counted in
  session token/cost totals), `retainedTail` (materialized
  `AgentMessage[]` kept after compaction — doubles as a self-contained
  checkpoint that replaces walking `firstKeptEntryId`), `details`,
  `fromHook`, and legacy `firstKeptEntryId`. `ToolResultMessage.usage` is
  documented as nested LLM work performed by the tool.
- **Pi's own totals**: billed/session totals over ALL recorded file
  entries. `agent-session.js getSessionStats` documents "Aggregates over
  ALL session entries (including history that was compacted away)";
  `usage-totals.js getUsageCostBreakdown` counts assistant messages +
  toolResult messages with usage + compaction / branch_summary entries with
  usage into session token/cost totals. Recorded component totals use the
  `totalTokens` field; reasoning is not part of the documented `Usage`
  contract (`docs/session-format.md` carries only input/output/
  cacheRead/cacheWrite/totalTokens/cost), so the reader surfaces it only as
  a recorded live-data field, never as an official-contract claim.
- **Installed**: 0.82.1 writes version 3 headers; 547 live session files
  under `~/.pi/agent/sessions/` are ALL version 3 (498 top-level + 49 nested
  `run-N/session.jsonl` files). Real records observed:
  message roles user/assistant/toolResult/bashExecution, custom_message,
  custom (extension state, e.g. `preset-state`), model_change,
  thinking_level_change, session_info, compaction (2, both fromHook with
  details), session header, label. **No `role custom` message entry, no
  `retainedTail`, no toolResult usage, no branch_summary** in live data —
  those paths are covered by official source/docs plus the new fixture.
- **Nested run-N files**: created by the pi-subagents extension
  (`sessionRoot/<runId>/run-0/session.jsonl`); each is a full v3 session
  with its own canonical header id and `parentSession: null`. Pi's own
  `SessionManager.listAll` does not recurse into them; the AgentSession
  walker does, and surfaces them as standalone Pi sessions with no invented
  lineage (directory name carries the relationship but the file header does
  not — not mapped as a relationship).

## Gaps and mapping (reader only; no schema rewrite)

1. **Custom-role messages dropped.** `piRecordsToMessages` handled
   user/assistant/toolResult/bashExecution only; a `message` entry with
   `role: "custom"` (v3) or legacy `"hookMessage"` (v2 pre-migration) was
   silently dropped. Fixed: both map to the system/custom view under the
   same display gate as `custom_message` entries (`display === true`);
   `metadata.legacyRole` records the v2 spelling, `metadata.customType`
   and `details` keep the recorded extension identity. Nothing not recorded
   is invented.
2. **Compaction evidence ignored.** `piCompactionEntry` now surfaces
   `retainedTailCount` (length of the recorded materialized tail) and
   `fromHook`; both go into the context.compaction event `providerData` and
   the metadata-only artifact. `retainedTail` message bodies are deliberately
   NOT expanded into conversation messages (they are checkpoint copies of
   entries that are already in the file's active branch; duplicating them
   would fabricate message positions) and are never given a synthetic
   `retainedFromEventId` when absent (`null` stays honest).
3. **Token totals undercounted.** `piTokenMapping` / session `tokenCount`
   counted assistant-message usage only; Pi's own totals also count
   toolResult nested usage and compaction/branch_summary summary usage. The
   reader now aggregates all recorded usage records across ALL file entries
   (`piRecordedUsageRecords` / `piRecordedUsage`), matching Pi's billed
   session total (`getSessionStats`/`getUsageCostBreakdown`, which aggregate
   all session entries including compacted-away/abandoned history), keeping
   component totals only — no direct/inherited/shared slices (no origin
   evidence in Pi records; verified in the 0.84.4 source + docs + live data).
4. **Future-format semantics are not claimed.** The parser's existing branch
   handling (v1 linear fallback, v2+ parentId branch walk) is unchanged;
   no test or doc claims behavior for versions beyond the verified v2/v3
   evidence. No version-specific rewrite anywhere; read-only guarantees
   unchanged.

## Decision

Refresh the Pi reader to the official current session format v3 / npm 0.84.4
snapshot and keep mapping strictly to recorded fields:

1. Map `message.role "custom"` (v3) and legacy `"hookMessage"` (v2)
   entries into the conversation view under the same display gate as
   `custom_message` entries (`display === true`), preserving customType /
   details and marking the legacy spelling.
2. Record compaction/branch_summary evidence `retainedTail` (as a count of
   recorded retained messages — never expanded into the message list) and
   `fromHook` in context.compaction events and artifacts.
3. Count all recorded usage (assistant + nested toolResult + summary usage)
   across ALL recorded file entries in session token totals and daily token
   stats, matching Pi's own billed session total (`getSessionStats` /
   `usage-totals.js`, aggregated over all entries including
   compacted-away/abandoned history), with component totals only
   (`totalTokens`; no origin slices).

No parser rewrite, no task/agentRun/spawn/child mapping, no lineage from
nested run-N directory names.

## Evidence boundary

- Negative conclusions ("no origin slices", "no task abstraction") hold for
  this snapshot only: official 0.84.4 package + pi-mono HEAD + live 0.82.1
  v3 data. Marked `supported` in the evidence matrix; `pending/unknown`
  remains for providers not yet refreshed.
- 49 nested `run-N/session.jsonl` files: discovered and shown as standalone
  Pi sessions (canonical ids preserved); the `parentSession: null` header is
  kept as-is — no fabricated subagent/spawn/child relationship.
- No provider data was written, no Pi installation was upgraded, `dist/` was
  not hand-edited (build regenerates it).

## Files changed

- `src/providers/pi/parser.ts` — custom/hookMessage role mapping;
  `piRecordedUsageRecords`/`piRecordedUsage`; compaction metadata
  (`retainedTailCount`, `fromHook`); authoritative tokenCount source.
- `src/providers/pi/protocol.ts` — compaction evidence fields in event
  `providerData` and artifact metadata.
- `src/providers/pi/adapter.ts` — token mapping over all recorded usage;
  contextArtifacts capability details updated.
- `test/fixtures/pi-v3-current.jsonl` (new) — bounded current-format fixture
  (v3 header, custom-role messages incl. display:false, retainedTail +
  usage + details + fromHook compaction, toolResult usage, branch_summary
  usage, label/custom/model_change/thinking_level_change entries,
  abandoned-line branch semantics).
- `test/pi-format-v3.test.mjs` (new) — current fixture regressions, protocol
  evidence assertions, v2 hookMessage legacy readability, malformed-line
  error.
- `docs/specs/work-graph-protocol/evidence-matrix.md`, `docs/CONTRIBUTING-PROVIDER.md`,
  `README.md`, `README.en.md`, `docs/prompts/backend-evolution/04-provider-freshness-refresh.md`,
  `docs/prompts/backend-evolution/00-bootstrap.md`,
  `docs/prompts/backend-evolution/01-usage-origin-slices.md`,
  `docs/prompts/README.md`, `docs/design/ui-v2.md`,
  `docs/specs/work-graph-protocol/design.md` — freshness/version/slice status
  refreshed.

## Alternatives considered

- **Expand retainedTail into conversation messages.** Rejected: retainedTail
  is a materialized context payload rather than a source-ordered session entry;
  expanding it could duplicate content and would fabricate message positions.
  It is recorded as count-only evidence in events/artifacts instead.
- **Synthesize `retainedFromEventId` from retainedTail.** Rejected: no
  single event id exists in the record; `null` is the honest value.
- **Map nested run-N directory names to parent lineage.** Rejected: the
  session file header records `parentSession: null`; the relationship lives
  only in extension directory conventions, not in the session record —
  inventing it would violate the no-invented-lineage invariant.
- **Keep token totals assistant-only.** Rejected: Pi's own session totals
  count toolResult and summary usage; excluding them undercounts recorded
  token truth.

## Consequences

- Pi sessions with recorded custom-role messages now surface them (visible
  ones only); v2 files with hookMessage entries stay readable.
- Compaction artifacts/events expose retainedTail count and fromHook as
  recorded metadata; the Workbench can render bounded evidence without
  message duplication.
- Token totals now match Pi's own all-entry accounting. Existing branchy
  sessions can increase relative to the former active-branch-only total because
  billed usage on abandoned/history branches is now included intentionally.
- Origin-slice status for Pi flips from pending/unknown to snapshot-verified
  "no slices" for 0.84.4 / v3 (no record in source, docs, or live data).
- Future Pi format drift must re-verify against a new snapshot; the nested
  run-N fixture behavior is documented, not treated as provider schema.

## Verification

- `npm run build` — clean.
- `node --test test/pi-format-v3.test.mjs` — 4/4 pass.
- `npm test` — **357/357 pass** (353 pre-existing + 4 new; two existing Pi
  token assertions updated to the provider's all-entry billed-total scope).
- Live-data validation: 547 real v3 files scan/parse through the built
  adapter; current live session parsed with recorded usage totals
  (148 assistant usage records; no toolResult/summary usage in live data).
- Not run: browser E2E (no UI behavior changed; protocol surface additions
  are metadata-only and the Workbench consumes existing kinds).
- `git diff --check` / `npm run check:governance` — see completion report.
