---
status: implemented
date: 2026-09-10
decision: Add a read-only native DeepSeek Harness Session format v3 reader while retaining frozen v0-v2 generations.
---

# DeepSeek Harness alpha.2 Session format v3 reader

Evidence: official read-only checkout `tmp/dsh-alpha15-audit/repo`, tag
`dsh-v0.1.5-alpha.2`, commit
`b2e3b2a0125854567a4a5fcba75782e42fe84901`.

## Context

The DSH adapter currently follows `0.1.3-alpha.2` and reads through Session
format v2. The newest official package, `0.1.5-alpha.2`, writes immutable
`session.v3.jsonl[.zstd]`. V3 materially changes the surface contract: system
prompts become `system/message` events, replacement endpoints become
`startSeq/endSeq`, and code-dispatch lifecycle tags become PTC tags.

## Decision

- Discover and read native v3 as the highest canonical generation, preserving
  the existing no-fallback rule and all historical v0-v2 readers.
- Keep provider data read-only. AgentSession validates and projects native v3;
  it does not run DSH's v2-to-v3 migration or publish a successor file.
- Validate the v3 envelope and surface properties consumed by AgentSession,
  including the four surface types, canonical replacement coordinates,
  provenance, retired system-header field, and required/ignorable vocabulary
  boundary.
- Project effective v3 system surface as system-prompt/context evidence without
  inserting system messages into the human Conversation or table of contents.
- Preserve existing provider-native Session Protocol v3 facts. New DSH event
  names do not by themselves prove new work, execution, coordination, actors,
  goals, or token-origin ownership.
- Freeze OpenClaw outside this change.

## Alternatives considered

Treating the update as documentation-only would leave current DSH sessions
invisible. Running the upstream migration would write provider-owned state and
violate the viewer boundary. Interpreting native v3 as v2 would silently apply
the wrong surface and system-prompt semantics.

## Consequences

Current DSH v3 sessions become visible without changing provider-owned bytes,
while older generations retain their established behavior. The adapter gains a
version-specific surface branch and fixture obligations; unsupported future
required semantics continue to fail explicitly instead of being approximated.

Recorded absolute working directories use the source host's Windows or POSIX
path syntax, independently of the viewer OS. The parser preserves that string;
it does not rewrite foreign source paths to a local working directory. Linux
CI exposed the previous host-only `isAbsolute` validation rejecting Windows
fixtures, so validation now accepts either absolute-path syntax at this boundary.

## Verification

- The checked-in official fixture matches upstream SHA-256
  `eb7ecaf5fdd8a2b95959ef9cc5eebba5761848f014e4e1a99eaf6134515898cb`
  and parses as 200 physical records without modifying provider-owned bytes.
- DSH-focused format, provider, protocol v2, and protocol v3 tests pass 29/29;
  the full suite passes 511/511; governance and typecheck pass through
  `npm run review`.
- An isolated live server over the official fixture exposes one canonical
  69-message session, a valid 199-event Protocol v2 snapshot, and complete
  Work, Execution, Coordination, and Context projections without diagnostics.
- Browser checks exercised Conversation, Events, and all four Work Graph lenses
  at 1280 px and 320/390 px with no horizontal overflow, page error, console
  error, duplicated system message, or table-of-contents regression.
- Independent review findings for protected system-head replacement, v3
  attempt usage, and generation-specific seed metadata were fixed and covered
  by regressions. The current local DSH package is `0.1.5-alpha.2`; its existing
  14 user sessions remain historical v0 inputs and their source manifest stayed
  byte-identical during verification.
- The source-host cwd regression and focused DSH/OpenClaw fixture checks pass
  29/29 on local Node 26.5.1 and the declared minimum Node 22.15.0. The official
  v3 fixture still parses as 200 records. Remote Linux CI rerun remains pending.
