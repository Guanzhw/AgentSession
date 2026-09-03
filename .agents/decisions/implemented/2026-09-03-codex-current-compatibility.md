---
status: implemented
date: 2026-09-03
decision: Refresh Codex CLI parsing/protocol support for the official 0.153
rollout shapes while preserving the existing 0.151 native-v3 mapping and
unknown states where delivery or lineage evidence is absent.
---

# Codex current rollout compatibility

## Evidence

- Installed Windows CLI: `codex --version` → `codex-cli 0.152.1`.
- Official release tag: [`rust-v0.153.0`](https://github.com/openai/codex/releases/tag/rust-v0.153.0), peeled commit `41e22fee981a63b3698df7ed36bad393cda24715`, published `2026-09-03T01:37:38Z`.
- Official `openai/codex` HEAD on `2026-09-03`: commit
  [`36984da4424cb91b6bc88c6af8d73207930ac729`](https://github.com/openai/codex/commit/36984da4424cb91b6bc88c6af8d73207930ac729).
- Official source at that HEAD defines `.jsonl.zst` cold-rollout files,
  first-class `token_usage_record` and `inter_agent_communication` rollout
  items, and the namespaced v1 `multi_agent_v1/close_agent` operation.
- The local 0.152.1 inspection snapshot (`01a065a2-fe5f-7192-ae2e-ec5fb6e91eff`)
  contained 413 records: one `session_meta`, 65 `event_msg/token_count`, one
  `inter_agent_communication_metadata`, and no first-class communication
  item. A real historical 0.151.0-alpha.7.2 rollout retained the existing
  native-v3 evidence: 9,689 records, 1,526 token events, 165 collaboration
  calls, 13 compacted records, and 15 goal updates. Bodies were not copied.

## Context

Codex is transitioning from plain JSONL rollouts and event-based token
snapshots to compressed cold files, first-class inter-agent records, and
per-response usage rows. The existing adapter already covered the observed
0.151 native-v3 collaboration and compaction shapes, but did not read the
official compressed representation or the newer record types.

## Decision

1. Decode official `.jsonl.zst` files in the Codex provider and prefer a plain
   sibling during representation transitions.
2. Treat `token_usage_record.payload.usage` as one recorded request. Do not
   count cumulative `turn_token_usage` or `thread_token_usage`; existing
   `event_msg/token_count` behavior remains intact.
3. Preserve first-class `inter_agent_communication` only in the v3 actors and
   `message` coordination observation with recorded sender/recipient but
   unknown delivery status absent acknowledgement evidence. It does not enter
   linear messages, v2 events, message counts, or the table of contents.
4. Accept the explicit collaboration namespaces used by current and legacy
   Codex (`collaboration`, `multi_agent_v1`, `multi_agent`, `multi_agents`). Map `close_agent` to
   the existing v3 `interrupt` kind because the shared protocol has no
   separate close kind; explicit success/failure output maps to
   `completed`/`failed`, ambiguous output stays `unknown`, and missing output
   stays `requested`.
5. Keep canonical session ids, raw source order, child lineage, and unknown
   status semantics unchanged. No provider data is written.

## Alternatives considered

- Rewrite the parser around the unreleased local 0.153 format. Rejected because
  0.153.0 is not installed; the bounded source-backed additions preserve the
  existing 0.151 and local 0.152 behavior.
- Count every usage field in a current usage row. Rejected because
  `turn_token_usage` and `thread_token_usage` are cumulative views, not
  additional requests.
- Infer communication delivery or child lineage from names and counts.
  Rejected because the rollout does not record an acknowledgement or child
  session relationship in every case.

## Consequences

Current and legacy Codex rollouts can be indexed from either plain or
compressed storage, with canonical per-response request totals and explicit
unknown delivery where evidence is incomplete. The shared v3 protocol remains
provider-neutral; `multi_agent_v1/close_agent` is represented by its nearest
existing `interrupt` kind. A later live 0.153 rollout may add shapes requiring a
follow-up refresh.

## Verification

- Added source-derived bounded synthetic (not live capture)
  `test/fixtures/codex-current-v153.jsonl` covering current
  metadata, user text, spawn, first-class communication, namespaced close,
  per-response usage, compaction, and metadata marker records.
- Added compressed-rollout parser regression using a temporary zstd file.
- Focused Codex tests: 26/26 passed after build.
- Real-data read-only protocol smoke passed on current 0.152.1 and historical
  0.151.0-alpha.7.2 rollouts; both finalized v3 snapshots validated.

## Limitations

0.153.0 is not installed locally, so its first-class shapes are covered by
official source evidence and the bounded fixture rather than a live 0.153.0
rollout. Local 0.152.1 did not emit `inter_agent_communication` or
`token_usage_record`; those absences are snapshot observations only.
