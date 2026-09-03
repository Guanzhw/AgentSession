# Contributing a Provider

This guide explains how to add a local AI harness provider to AgentSession.
The adapter owns source parsing and provider-specific semantics; the viewer,
Runtime Workbench, and read-only MCP consume normalized contracts. Provider
databases, transcripts, and event logs must never be written, migrated,
deleted, or repaired.

`src/providers/interface.ts` is authoritative. Keep provider behavior under
`src/providers/<provider-id>/` and do not add central provider-ID branches in
routes, projections, or browser code.

## Provider evidence freshness

Provider formats evolve independently. Before changing any provider parser,
schema mapping, or protocol mapping, verify the evidence snapshot:

1. Check the official docs, the upstream repository HEAD or release/package
   dist-tag, the locally installed version, and the newest local real data
   available for that provider.
2. Record `verified-at` (date), the version/commit checked, the official
   source link(s), and the sample format(s) inspected. Keep this record with
   the change (decision record or evidence note); never reuse an old record
   for a new change.
3. Negative conclusions ("no X recorded") hold only for that snapshot. Do not
   restate them as permanent provider capabilities, and never write an
   absence as an indefinite negation.
4. When format drift is found, mark the affected support explicitly as
   `supported` / `legacy` / `pending` (e.g. "current-format support pending
   until refreshed against the newest version") and keep the
   unsupported/legacy diagnostic truthful.
5. Never auto-upgrade the user's installation and never write provider data:
   documentation and adapter refresh is read-only with respect to provider
   storage and installed versions.

When capability or format-support wording changes, update the provider table
in both READMEs and the evidence matrix, then run `npm run
check:governance` and `git diff --check`.

## Contract boundary

## Contract boundary

Every adapter implements `ProviderAdapter`:

- stable lowercase `id`, display `name`, and `icon`;
- `detect()`, `getDataPath()`, `scan()`, and `getSession()`;
- normalized `getMessages()`, trusted `getTokenStats()`, and bounded `searchMessages()`;
- optional `exportSession()`, runtime-environment evidence, system-prompt evidence, structured conversation projections, and a provider-owned resume command;
- `protocolCapabilities` and `getSessionProtocol(sessionId)` for every readable session;
- `getStorageDiagnostic()` when a detected backend is known but unsupported.

IDs are canonical everywhere: scan results, lookup, URLs, metadata keys,
exports, resume commands, protocol references, and MCP requests. Use Unix
milliseconds. A malformed individual source file must not stop other sessions
from loading; preserve a bounded diagnostic and use `null` or an empty
collection where the contract permits unavailable optional data.

Raw source fields are normalized at the adapter boundary. Browser code must
not interpret provider schemas. Preserve nullable message fields (`thinking`,
tool name/input/result, tokens, metadata) explicitly, and keep reasoning,
assistant text, tool calls, and tool results inside their source response
boundary.

## Choose a reference adapter

| Source shape | Reference | Boundary to preserve |
|:---|:---|:---|
| JSONL transcript | `src/providers/claude-code/` or `src/providers/codex/` | Record order, response boundaries, and child evidence. |
| Branch-tree JSONL | `src/providers/pi/` or `src/providers/openclaw/` | In-file branches and canonical parent/session IDs. |
| Event-sourced JSONL with Zstd frames | `src/providers/deepseek-harness/` | Frame decoding, packed-row keys, source sequence, and required event vocabulary. |
| Provider-native SQLite | `src/providers/hermes/` | Provider schema, WAL snapshots, and lineage remain local to the adapter. |
| OpenCode SQLite | `src/providers/opencode/` | Only the OpenCode schema is supported; arbitrary SQLite is not interchangeable. |

Shared helpers in `src/providers/shared/` are schema-neutral: file caching,
message/session projections, runtime evidence, canonical project mapping, and
Session Protocol validation/finalization. Do not move provider field
assumptions into those helpers.

## Session Protocol v2

Every registered provider must expose a protocol for every readable session.
Message remains the universal conversation projection; protocol v2 is the
structured harness contract.

Use canonical references at every graph and query boundary:

```ts
type SessionRef = { provider: ProviderId; sessionId: string };
```

The finalized protocol contains `version: 2`, a session descriptor, events,
relationships, tasks, agent runs, context artifacts, optional branches,
validation, completeness, and a provider revision.

### Events

Events retain source order and exact source anchors. `sequence` is dense and
one-based in AgentSession's normalized projection; timestamps never reorder
events. Emit a normalized category (`session`, `message`, `model`,
`reasoning`, `tool`, `task`, `run`, `context`, `control`, `team`, or
`unknown`) and a stable normalized kind while preserving provider-native kind
and bounded safe attributes in provenance/provider metadata.

Every value carries `provenance.fidelity`: `recorded` when the source stores
the fact, `derived` when the adapter reconstructs it. Unknown required source
semantics must leave the session incomplete with a diagnostic; unknown
ignorable events may remain `unknown` events. Never silently drop required
events.

### Relationships, Tasks, and AgentRuns

Relationships preserve type, direction, canonical source/target refs,
timestamp, provenance, and event/task/run anchors. Supported types are
`parent`, `spawned`, `forked`, `continued`, `compacted-into`,
`scheduled-run-of`, and `handed-off`. `spawned` is the only relationship that
implies detached subagent work; lineage and collaboration edges do not.

`Task` is requested work: status, title, owner/assignee, dependencies,
schedule, deadline, revision, and outcome. `AgentRun` is one attempt: mode,
agent/model, task, trigger, parent run, child session, timing, outcome, and
failure/cancellation reason. Keep run mode on `AgentRun`, never on `Task`.

### Context and branches

Context artifacts are metadata-first. Preserve kind, scope, origin,
`contentAccess`, source path, producer/consumer/citation links, source session
IDs, version/lineage, hash, redaction, and a short non-sensitive summary.
Never copy transcript or compaction text into an artifact. Emit context
lifecycle events (`context.loaded`, `context.reinjected`, `context.cited`,
`memory.generated`, `memory.consolidated`) only when the source supports that
observation; plain compaction alone is not a lifecycle event.

In-file branches use event/message IDs and remain branch topology. They never
create a second canonical session or a fabricated cross-session edge.

Implement with the factories and validator in
`src/providers/shared/session-protocol.ts`, then finalize through the shared
runtime path so validation, caching, revisions, and projections stay uniform.

## Configuration and launch boundaries

When a source has only an opaque project key, keep it as
`metadata.projectKey`. A user may provide an existing absolute directory in
the top-level configuration:

```json
{
  "projectPaths": {
    "my-tool": {
      "opaque-project-key": "C:\\work\\project"
    }
  }
}
```

This is viewer-owned lookup data; it never mutates provider storage and never
guesses a path. Add a provider CLI data-path flag only when the provider root
is configurable. A resume command is optional and must be a structured
provider-owned executable/argument specification. Do not advertise resume when
the source lacks a stable selector or project directory. DSH currently has no
default resume command.

Terminal launch is resume-only. Do not add write-capable management or launch
tools to AgentSession-MCP.

## Provider registration and MCP

1. Add the lowercase ID to `ProviderId` and register the adapter once in
   `src/providers/index.ts`.
2. Ensure unavailable providers remain in `getAllProviders()` while only
   detected providers enter `getAvailableProviders()`.
3. Keep provider-specific parsing and projections out of routes and views.
4. Confirm the MCP provider allow-list and tests accept the ID where the MCP
   package uses a static schema.
5. Keep all MCP tools read-only, bounded, and explicit that provider content
   is untrusted input.

## DeepSeek Harness requirements

For DSH, keep compatibility metadata synchronized with the checked-in snapshot:

- repository `deepseek-ai/deepseek-harness`;
- alpha.5 tag commit `db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5` (official
  HEAD `49a606bc5b5934603f22a26957a07dc799ab0291`);
- tag `dsh-v0.1.2-alpha.5`;
- package `@deepseek-ai/dsh@0.1.2-alpha.5`;
- session format `0`; current SQLite schema `null`, legacy schema `17`
  (alpha.5 has no session-persistence SQLite plugin; its SQLite packages are
  a storage-kv facet and an FTS5 query backend).

JSONL is the primary backend. Test raw and multi-frame `.jsonl.zstd`, packed
`text-chunks`/`reasoning-chunks`/`tool-call-chunks`, zero-based upstream
sequence, range-encoded `sourceEventSeqs`, header identity, `request/header` and
`request/context`,
`session/end-seed`, fork seed length, source-event citations, surface
replacement, compaction, cancellation/interruption, workflow/subagent facts,
`agent/inbox/spliced`, Agent Teams member/task/mailbox events, `model/selection`,
`subagent/model-selection-policy`, and `session-log-deepseek/delivery-accepted`.
These records are control/model/delivery facts, not ordinary messages. Preserve
dangling references as unresolved diagnostics; never invent a readable child
session. Keep the alpha.3-derived and rc.8 fixtures as readability regressions
and the official alpha.5 web snapshot (byte-for-byte) as the current fixture,
synthesising its omitted `seq`/`time` per upstream `parseSessionLog`.

If legacy SQLite persistence or another known backend is detected but unsupported,
return an explicit storage diagnostic naming the detected and expected schema.
Never silently treat durable data as an empty provider.

## Tests and acceptance

Use provider-owned fixtures for current, legacy, malformed, unavailable,
derived, unsupported, dangling, and cyclic records. Check:

- canonical IDs and source-order sequence stability;
- parser corruption isolation and cache invalidation;
- nullable message normalization and token non-duplication;
- truthful capability descriptors and protocol validation diagnostics;
- relationship anchors, Task/AgentRun separation, branch topology, context privacy, and canonical links;
- unavailable and unsupported-backend behavior;
- `/api/providers`, `/protocol`, Runtime summary/events/graph, and the detail page;
- MCP search/get/timeline/context/event bounds and untrusted-content handling;
- a real local source, not fixtures alone, when provider schemas or paths are involved.

Run at least:

```powershell
npm run typecheck
npm test
npm run build
```

For user-visible changes, restart the loopback server, inspect `/api/providers`
and representative protocol/runtime responses, then run `npm run qa:e2e` at
desktop and 390px widths. Review `git diff --check`, confirm provider data was
not changed, and update both READMEs when public capabilities change.

## Related source

- `src/providers/interface.ts` — authoritative adapter contract.
- `src/providers/shared/session-protocol.ts` — v2 types, factories, validator, and finalizer.
- `src/protocol-runtime.ts` — cache and bounded Runtime projections.
- `src/providers/deepseek-harness/compatibility.ts` — DSH compatibility snapshot.
- `src/providers/pi/` — compact provider-specific protocol example.
- `packages/agentsession-mcp/src/session-history-server.ts` — read-only MCP boundary.
- [`docs/specs/runtime-protocol-workbench/`](./specs/runtime-protocol-workbench/) — requirements and design source.
