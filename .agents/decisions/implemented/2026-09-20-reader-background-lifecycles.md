---
status: implemented
date: 2026-09-20
decision: Normalize observed tool execution lifecycles and read their relationship to the main conversation in local time lanes
---

## Context

Reader already groups intermediate tools under their assistant turn. That preserves
content but does not explain an operation which yields, permits the main agent to
continue, and returns later. Real Codex records contain an outer async `exec` call,
an explicit cell handle in its yielding output, and subsequent `wait` calls with
that handle. Handles can be reused after completion. Nested script outputs may
contain several independent tool results with no recorded inner call identity.

## Decision

Add a small typed execution observation to source-anchored protocol events. The
provider owns tool vocabulary, handle binding, occurrence identity, and terminal
meaning. The implemented kinds are `async-tool` and `process`, distinct from AgentRun and team
coordination. A started occurrence and its waits/results share an identity;
reused handles start a new occurrence. Main-thread text remains ordinary prose.

Reader uses these facts to place compact yield/stop-request/return markers in the complete
conversation. Opening the local execution view presents main/background time lanes,
including overlapping work, and links each step to its complete original command
or output. Dense polling is a secondary expansion. Layout and selection are shared;
provider interpretation never moves into browser code.

Observe the outer script as an async tool when its handle is explicit. Do not infer
the identity, process exit, or ordering of nested commands from JavaScript source or
the order of returned payload blocks. Interruption requests and recorded termination
are separate facts. A saved running observation describes that point in history.

Direct `exec_command` / `write_stdin` records observed in Codex Desktop 0.142.0
carry independent call IDs and native `Process running with session ID` / `Process
exited with code` headers. These support the `process` kind using the same Reader
path. The provider supplies a bounded command excerpt as its label; nonempty
stdin records an input step and Ctrl-C records a stop request. Exit 0 after a stop
request remains a recorded completion, not an invented cancellation.

## Alternatives considered

Treating every tool as an AgentRun would confuse commands with agents and enlarge
the task directory. A global event list would repeat the current reading problem.
Guessing inner execution bindings from source text would create false relationships.
Existing original-tool rendering remains the complete content path.

## Consequences

The protocol gains an additive event detail with one concrete Reader consumer.
Ordinary synchronous tools keep their existing presentation. Provider coverage is
reported by actual transcript shape, not by whether a provider's basic page opens.
The initial async-tool slice and direct terminal support are verified separately.
Provider source-shape gaps and Teams acceptance stay explicit in the delivery plan.

## Verification

The unified build and full suite pass on current and minimum Node 22.15.0. Fixtures
cover occurrence reuse, interleaved handles, exact call/result identity, repeated
waits, stop requests without invented cancellation, missing return, prefix-bound
paging, and clipped concurrent lanes. Real Codex completion and failure histories
verify original command/output navigation; desktop light/dark checks verify all
six steps, cached expansion on Back, and both crosslinks below the sticky header.
The direct terminal sample contains three processes and fourteen steps. Its
10,910-character output was read through all four pages in the browser and matches
the original output SHA-256; Ctrl-C followed by exit 0 remains completion.
The separation arrow matches yielded time rather than initial call time. See the
[acceptance record](../../../docs/design/runtime-acceptance-evidence.md) for full
suite, E2E, real API results, and unsupported source shapes.
