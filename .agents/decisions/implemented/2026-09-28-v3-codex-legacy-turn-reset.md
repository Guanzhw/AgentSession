---
status: implemented
date: 2026-09-28
decision: Exclude Codex legacy request mirrors only after a recorded turn reset proves their cumulative offset.
---

## Context

Some mixed Codex JSONL files record each response as both a canonical `token_usage_record` and a legacy `event_msg:token_count`. At a new turn, the legacy cumulative vector can reset to that turn's usage while the canonical thread cumulative continues. The earlier thread-offset mirror rule retained these legacy rows. A read-only audit of six frozen files established 781 residual legacy mirrors and seven compaction context snapshots, 788 rows total; the frozen sources did not change.

## Decision

The Codex adapter starts a legacy reset offset only when a complete legacy request and cumulative vector equal the nearest identified canonical response's complete request and turn cumulative vectors, the canonical thread cumulative advances additively, the recorded turn ID changes, and the prior complete legacy cumulative total falls. Later legacy rows are mirrors only when their complete request matches the nearest canonical response and their cumulative vector exactly equals the canonical thread cumulative minus that reset offset. A validated compaction adds its recorded request cost to the offset; its context snapshot is not a request. An independent later reset may establish a new offset. Exact repeated legacy mirror rows retain that proof without hiding a distinct following canonical response.

Stats usage projection version 4 and catalog stored-summary schema version 5 force unchanged source files to be recaptured on restart.

## Alternatives considered

Matching equal request vectors alone would erase distinct requests. Matching turn cumulative vectors alone explains the first 232 residual mirrors but leaves later turns and compactions counted twice. Global cumulative subtraction without a recorded reset would infer missing provider behavior.

## Consequences

The adapter leaves incomplete or unproven legacy rows available as requests. The schema change recaptures existing stored summaries for all providers once; the Stats projection version recaptures persisted usage rows. Provider sources remain read-only.

## Verification

Rust tests first failed for the new-turn duplicate, the post-reset compaction case, a distinct equal-request canonical successor, and immediately preceding cache versions; they pass after the change. Direct read-only checks of six frozen files retained all 1,548 canonical request rows and excluded all 788 independently proven residual legacy rows, with exact per-file request totals and source SHA-256 unchanged. This six-file evidence does not establish a full-corpus gold total.
