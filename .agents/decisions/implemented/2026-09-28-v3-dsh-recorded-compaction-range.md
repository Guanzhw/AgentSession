---
status: implemented
date: 2026-09-28
decision: Project DSH summary replacement scope as a recorded Context transformation while leaving context windows unknown.
---

# DSH recorded compaction range

## Context

The DSH v3 `compaction/summary` row records `shadowedRange`, `shadowedSeqs`, and `shadowedTokenCount`. AgentSession 3.0 already positioned its readable summary in the Reader and emitted a Context observation, but the v3 Context result and replacement scope were absent. The public fixture records range 0–0, sequence 0, and 123 tokens. A frozen DSH source has three summary rows with distinct recorded ranges.

## Decision

The DSH adapter parses those three optional source fields once at the provider boundary and creates one ContextVersion and ContextTransformation for each owned `compaction/summary` that has a readable Reader checkpoint. The version and transformation use the same source event, one-based protocol sequence, Reader reference, timestamp, and recorded provenance. The transformation reports the source range, exact listed sequences, and token count when recorded. Source and parent version IDs remain empty; no context window or retained tail is inferred. Summary rows without readable content keep their existing Context observation and source event without inventing a result version.

The shared protocol validates range ordering and the existing result/event anchor. Runtime Context shows the recorded scope and opens the summary in the Reader. The source event remains available for full raw inspection.

## Alternatives considered

- Infer a full sequence of context windows from successive compactions. DSH records the replacement scope here, but this fixture does not identify complete windows or their retained content.
- Keep the scope only in raw event JSON. That leaves the v3 Context API and Runtime view unable to expose a recorded fact needed to explain the compaction.

## Consequences

The v3 Context transformation can describe the exact recorded replacement scope and link to its readable result. Other providers omit these optional fields. A summary row without readable content remains an observation; no result version is claimed for it.

## Verification

The public fixture HTTP test was RED with only `contextObservation`, then GREEN with the v3 result, source fields, validated v2/v3 facts, MCP continuation, and browser Reader link. The frozen DSH Web test compared each of three Context results with independently decoded source rows for range, sequence list, and token count; the source hash remained unchanged. Focused Rust DSH tests, Svelte build, and repository review passed. The delivery-plan evidence row records exact commands and remaining gates.
