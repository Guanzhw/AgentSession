---
status: implemented
date: 2026-09-27
decision: Project only recorded Codex outer tool and direct-process execution phases into shared protocol events.
---

# Codex recorded execution phases

## Context

Codex transcripts contain `exec`/`wait` outer tool calls and
`exec_command`/`write_stdin` process calls. Their outputs may also contain
arbitrary nested JavaScript or text mentioning unrelated IDs. The Reader and
Runtime need one source-backed account of when work separated, was polled,
received input or a stop request, and returned.

## Decision

The Codex provider pairs calls and outputs by recorded `call_id`, then reads
only an exact outer result header within a 4 KiB prefix. It tracks active
outer cell and process handles in separate domains. Each observed phase is a
source-ordered protocol event with its original tool Reader reference. The
shared v2/v3 and Runtime projections carry the same execution fact: kind,
occurrence ID, phase, handle, tool name and optional process label. A stop
request is `interruption-requested`; only an actual recorded result determines
`completed` or `failed`. A terminal result releases its handle for later reuse.
Unreturned work stays yielded, and nested output cannot create a phase.

## Alternatives considered

- Infer work from a session ID inside arbitrary tool output: nested values are
  not outer execution handles.
- Treat Ctrl-C or `terminate: true` as cancellation: the request does not
  establish the process outcome.
- Mix numeric process and cell handles: equal digits do not mean the same
  occurrence.

## Consequences

Protocol and Runtime can point to exact Reader tools while retaining distinct
execution chains and missing-return states. The Reader's full two-ended
execution presentation and long-output navigation remain separate product
work under WEB-13.

## Verification

Fixed 2.0 produced four outer-tool phases and eight direct-process phases on
the matching public transcripts. `v3/test/codex-execution-http.test.mjs` and
`v3/test/codex-process-http.test.mjs` were RED on empty execution observations
and now pass 3/3 against real Axum, including interleaved and reused handles,
overlapping waits, failure and interruption. Rust workspace tests passed with
81 core and 2 app tests; 10 private opt-in tests were ignored. A frozen real
outer exec/wait source passed the four-phase check without source changes.
