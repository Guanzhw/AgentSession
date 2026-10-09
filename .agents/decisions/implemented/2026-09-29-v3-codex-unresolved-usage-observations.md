---
status: implemented
date: 2026-09-29
decision: Only source-proved Codex responses enter usageRecords; unresolved source occurrences remain usageObservations and do not contribute to request statistics.
---

# Codex unresolved usage observations

## Context

CORE-14 requires usage totals to include requests whose ownership is recorded
and clear, while keeping copied legacy usage, cumulative snapshots, missing
fields, and incomplete coverage distinct. The complete frozen ledger contains
73,997 legacy token-count occurrences and no explicit response IDs on those
rows. Four independently selected witness packs contain 338 unresolved legacy
occurrences. A bounded runtime check returned 59 of 206 independently proved
canonical response IDs but also exposed 53 legacy-derived protocol rows whose
request identity remains unresolved. These results establish a specific gap in
the current Codex projection; they do not classify every legacy occurrence in
the corpus.

See the [raw occurrence ledger](../../../docs/design/agentsession-v3-codex-raw-usage-ledger.md),
[public witness summary](../../../docs/design/agentsession-v3-codex-usage-witness-packs.md),
and [bounded runtime result](../../../docs/design/agentsession-v3-codex-usage-witness-runtime.public.json).
The retained source payloads and occurrence locations remain private.

## Decision

Session Protocol v3 has two collections. `usageRecords` contains a Codex request
only when a canonical `token_usage_record` has a response ID, its explicit
`thread_id` matches the active `session_meta` owner, and repeated rows for that
response do not conflict in normalized request tokens. Distinct response IDs
stay distinct even when their token vectors are equal. A recorded `NEW_TASK`
boundary excludes pre-boundary child rows. A matching usage fingerprint in a
parent file is not ownership evidence and never suppresses an occurrence.
Canonical rows with an explicit foreign `thread_id` remain raw events but
enter neither the child's requests nor its observations.

Every remaining owned usage occurrence is a `usageObservation`, including each
anonymous `event_msg/token_count` row and canonical rows without sufficient
request proof. Its occurrence ID and event anchor use the native record index;
it retains the normalized last-usage vector, any recorded cumulative vector,
timestamp, and recorded provenance. Equal vectors, cumulative snapshots, turn
placement, and adjacency neither promote nor erase an observation. The bounded
Runtime execution domain pages these observations with source order and a
revision-bound cursor.

Stats aggregates only usageRecords. When a selected source contains unresolved
usage observations, JSON and CSV keep the usage coverage marked partial; if
there are no proved requests, request counts remain zero and token totals remain
unknown. JSON reports unresolved occurrences as
overview.unresolvedUsageObservationCount and per-UTC-day counts; CSV exposes
the same daily count as Unresolved Usage Observation Count. The persisted Stats
usage projection advances from version 5 and preserves observation coverage so
old cached legacy-derived rows are recaptured. The Codex Library/list
`tokenCount` uses the same proved requests; a legacy-only session reports
`null`. Catalog summary schema 12 recaptures old persisted totals. An
observation does not claim to be an independent request, mirror, replay, or
context snapshot.

## Alternatives considered

Counting each complete legacy pair as a request preserves the existing overcount
when the source does not identify whether rows were copied, replayed, or merely
adjacent to a request. Dropping unresolved rows entirely loses recorded usage
evidence. Removing every equal vector can collapse distinct requests, while
pairing a legacy row to one canonical row by vector or cumulative equality still
lacks a source identity link.

## Consequences

Session Protocol v3 gains a distinct usage-observation collection while
`usageRecords` retains its request semantics. Codex owns extraction and source
provenance; shared validation keeps observations separate from request IDs and
Stats request aggregation. Stats cache invalidation and coverage projection
changed with that contract. Other providers publish an empty observation
collection without provider-name branches in shared Stats logic. The historical
legacy replay selector and its tests were removed because they no longer
determine request or Library totals. This boundary does not resolve multi-file
Codex sessions or establish full CORE-14 coverage.

## Verification

The [Codex HTTP integration tests](../../../v3/test/codex-usage-observations.test.mjs)
and [request tests](../../../v3/test/codex-request-usage-protocol.test.mjs)
passed 14 cases with one private opt-in case skipped against the focused-slice debug
binary SHA-256 `0cb1ad4b417742497ab3e72a3fba219e9b3b098e60d5c28af156d317a645f9ee`.
They show two equal-vector canonical response IDs as requests, four separate
anonymous occurrences as observations, bounded two-page Runtime retrieval,
mixed Library `tokenCount` 260, legacy-only Library `tokenCount` null, partial
Stats JSON/CSV with zero proved requests, and version-5 Stats cache recapture.
The fixture SHA-256 values are
`14c6c66b64e101665f229c77edeacfef6b3003ca25e31cc236b4e3ba335da172`
and `1fe1dda6cc53825e6da0a1d523cdbbf30a512e4031934df1fc9629f1fdd5f113`;
the tests assert source bytes remain
unchanged. Child regression cases preserve anonymous rows with parent-equal
usage vectors and retain explicitly foreign canonical rows only as raw events.
`cargo test --manifest-path v3/Cargo.toml -p agentsession-core
--locked --offline --quiet` passed 160 tests with 13 private cases ignored.
Validator tests cover duplicate/mismatched observation anchors and revision
cursor rejection. A Stats cache test keeps two anonymous child-file
observations across parent-source revision and confirms both projections are
recaptured. Catalog schema 11 recapture replaces a stale known token
total. `npm run check:governance` passed. No private transcript data was used
in this validation.
