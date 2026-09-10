---
status: implemented
date: 2026-09-10
decision: Reuse AgentRun for Codex session-owned turns with an explicit session-turn kind, unknown execution mode, and exact recorded lifecycle identity.
---

# Session-owned turn execution

## Context

Codex records session-owned `task_started`, `task_complete`, and
`turn_aborted` lifecycle observations. The recorded
`collaboration_mode_kind: default` does not establish a foreground execution
mode. Existing AgentRun already owns execution timing, status, provenance, and
nullable task/child references, while Conversation must not render a turn as a
detached agent card.

## Decision

Codex maps each owned lifecycle start with a recorded `turn_id` and
`started_at` to one `AgentRun` classified as `session-turn`, with
`mode: unknown`, `taskId: null`, and `childSessionId: null`. The stable run id
is derived from that recorded pair. A terminal binds only when exactly one
start and exactly one terminal share the pair; duplicate or conflicting
evidence remains explicitly unknown, and orphan terminals remain events with
no run anchor. Successful completion is `completed`; a completion carrying a
recorded error object is `failed` with only normalized `codex_error_info` as the
category; abort is `cancelled` with its recorded reason or `unknown`.

Lifecycle events preserve native source order and carry validated source
anchors. Existing v2 facts remain in the v3 snapshot. Request usage keeps its
existing record ids, count, and token components, and receives a run anchor
only when its recorded turn id identifies exactly one owned turn run.

## Alternatives considered

- Map `collaboration_mode_kind: default` to `foreground`. Rejected because the
  source records no such execution semantics.
- Join terminals to starts by timestamp proximity. Rejected because repeated
  or conflicting identities would fabricate an attempt pairing.
- Create a separate attempt entity. Rejected because AgentRun already owns the
  required execution facts and its nullable task/child references represent a
  session-owned execution.
- Copy Codex error messages into protocol facts. Rejected because only the
  normalized recorded error category is needed and message bodies are not part
  of the contract.

## Consequences

Execution exposes recorded Codex turn lifecycle evidence without changing
task/child/coordination semantics. Open prefixes remain unknown with no
fabricated end time. Explicitly classified turn runs remain available to the
Execution lens while Conversation, work progress, and delegated-work counts
continue to exclude them. Inherited parent records stay excluded by the
existing `loadCodexProtocolInput()` provenance boundary.

## Verification

- `npm run build` passed.
- `node --test test/codex-v3.test.mjs test/codex-provider.test.mjs` passed:
  34/34 tests, including complete success/failure, abort, open prefixes,
  duplicate/conflicting/orphan evidence, inherited filtering, stable identity,
  source ordering, v2 preservation, and unambiguous usage binding.
- Read-only real Codex source-to-builder parity check for
  `01a0576a-98e2-7c31-a265-6d98d5fbff12` passed with matching lifecycle counts;
  the finalized v3 snapshot validated successfully and exposed only the
  observed `usage_limit_exceeded` error category. No transcript message body
  was copied into the mapping.
- The initial bounded overview omitted session turns in the long root session.
  This observed gap required the independent run browser described below.

### Run browsing follow-up

The observed overview-budget gap is addressed by an independent run page:
default 50, maximum 100, directly sliced from finalized `agentRuns`. Cursors
bind canonical provider/session, direction, exact boundary run ID, and page
size; each request reads the latest finalized snapshot, so ordinary revision
changes do not force a restart. Missing anchors and conflicting limits remain
explicit refresh/input errors. Page replacement keeps DOM and page evidence
bounded, while current-page evidence wins over an older overview copy.

Real browsing of the actively appended Codex source invalidated the initial
revision-bound cursor before the next page loaded. This evidence led to the
canonical run-anchor contract above. A 390px check also exposed adjacent
start/end timestamps; separate grid rows corrected their presentation.

### Live-anchor acceptance

- Worker build and 67 focused projection/route/render tests passed.
- Main-agent `npm test` passed 530/530; `npm run review` passed.
- After restart, a real Codex cursor issued at revision 3 successfully returned
  runs 51–100 at revision 4, including 33 session turns. The current collection
  contained 160 runs. Ordinary writes no longer forced a refresh.
- Real browser interaction crossed tool-call/write boundaries, reached
  51–100, 101–150, and 151–160, and returned from the short final page to
  101–150. Turn evidence opened with recorded identity, status and provenance.
- A 390px screenshot verified the latest-state explanation, refresh control,
  run range, and separated start/end timestamps after the anchor change.
- Final post-anchor OpenCode `npm run qa:e2e` passed with `ok: true`, no
  browser errors, and an empty server error log.
- Independent Terra review found no source defects in lifecycle mapping,
  cursor boundaries, immutable-snapshot indexing, provider ownership or
  current-page evidence. Its remaining lifecycle finding is resolved by moving
  this record to implemented. DSH could not start a review because its local
  Host API returned HTTP 401; Terra supplied the independent review.
