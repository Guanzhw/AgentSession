# Session History MCP Implementation Plan

Status: implemented (V1); real-data acceptance timing remains release-gated
Scope: first implementation of a local, read-only MCP server for normalized
coding-agent session history, distributed as the separately publishable
AgentSession-MCP (`agentsession-mcp` on npm) package.

## 1. Decision And Boundary

This MCP server exposes only data that is directly associated with a coding
agent session:

- session metadata and canonical identity;
- the session's messages, visible reasoning, tool calls, and tool errors;
- parent/child session relationships that the provider records; and
- bounded context around an event in that session.

It is not an MCP interface for the wider analysis workflow. In particular, the
following stay out of scope:

- analysis runs, manifests, proposals, validation, or implementation handoff;
- project artifact snapshots and arbitrary project-file reads;
- provider runtime extensions such as AGENTS.md, skills, plugins, hooks, or
  reconstructed instruction sources;
- resume, terminal launch, settings changes, metadata mutations, or any other
  write operation;
- semantic/vector search and knowledge graphs.

The result is a reusable history-retrieval primitive. The existing session
analysis workflow can call it for session evidence, but it keeps ownership of
its own snapshots, artifact boundaries, output validation, and proposal-only
rules.

## 2. Goals

The first release must:

1. Search all currently available registered providers using keyword matching.
2. Resolve a session through its canonical provider session ID.
3. Return only normalized, provider-owned session information.
4. Let an agent inspect a bounded timeline, an exact event, or nearby
   conversation context without loading a whole transcript.
5. Use stdio so an MCP client starts the server as a local child process.
6. Keep provider databases and transcript files read-only.

The first release deliberately optimizes for evidence retrieval, not automated
memory. An MCP client must treat every returned transcript string as untrusted
data, never as a command or instruction to follow.

## 3. Existing Architecture To Reuse

The implementation must build on the existing provider boundary instead of
adding provider-name conditionals:

| Existing surface | Reuse in the MCP server |
|:---|:---|
| src/providers/interface.ts | Provider detection, canonical session lookup, normalized messages, and provider-local keyword search. |
| src/providers/index.ts | Registered and available provider enumeration. |
| src/index-db.ts | Viewer-owned session metadata index, including parent IDs, project directory, timestamps, and counts. |
| src/meta.ts | Read only the viewer-owned excluded-session set; do not expose stars, custom titles, or other viewer metadata as session data. |
| src/session-queries.ts | HTTP/dashboard presentation helper. It is a reference for result shape only; the MCP service must call adapters and index-db helpers directly. |
| src/server.ts | Refactor its duplicated scan/upsert loop to call the existing indexProvider(adapter) helper in index-db.ts. |
| src/config.ts | The MCP process uses the same config file and provider path options as the viewer. |

The current analysis helper is useful as a design reference only. Its evidence
IDs are specific to a frozen analysis snapshot, so this MCP must not accept an
analysis run directory or expose analysis-only artifact and extension commands.

## 4. Data Model

All public identifiers are structured objects rather than delimiter-joined
strings. This avoids ambiguity when a provider uses punctuation in an ID.

~~~ts
type SessionRef = {
  provider: ProviderId;
  sessionId: string; // Provider canonical ID.
};

type EventSegment = "message" | "thinking" | "tool";

type EventRef = SessionRef & {
  messageId: string;
  segment: EventSegment;
};
~~~

An event is a projection of the existing normalized Message contract:

- A message event represents Message.content for user, assistant, or recorded
  system messages.
- A thinking event represents Message.thinking only when the provider exposes
  visible thinking.
- A tool event represents Message.toolName, Message.toolInput, Message.toolOutput,
  and its normalized status/error fields.

Tool status is error, completed, or unknown only when the provider's normalized
message metadata supplies that fact. The provider-neutral projection falls back
to unknown; it must not infer success from missing output or add a
provider-ID-specific rule.

The server must not invent message IDs. When a provider cannot provide a stable
message ID, it is not eligible for event-level MCP access until its adapter
normalizes one that remains valid for getMessages(sessionId).

## 5. MCP Tool Contract

Every tool has a strict JSON Schema input and output schema, returns structured
content plus a short text fallback, rejects unknown input properties, and is
annotated read-only.

### 5.1 session_search

Searches titles and recorded session content across available providers.

Required input:

~~~json
{ "query": "EADDRINUSE" }
~~~

Optional input:

~~~json
{
  "providers": ["opencode", "codex"],
  "updatedAfter": 1710000000000,
  "updatedBefore": 1720000000000,
  "limit": 20
}
~~~

The result includes provider diagnostics, a bounded ordered list of matches,
and each match's SessionRef, optional EventRef, match field, snippet, title,
directory, and update timestamp. The result sets truncated when a provider's
bounded search result was exhausted; it must not claim an exact global total
when the provider API cannot supply one.

By default, matching includes session title, recorded normalized message text,
and recorded working-directory metadata. A tool name or error is searchable
only when its adapter exposes it through normal message search content. Search
excludes visible reasoning and raw tool input/output so broad keyword search
does not accidentally load sensitive, high-volume data into model context.

### 5.2 session_get

Returns one normalized session overview:

- canonical SessionRef;
- title, directory, created and updated timestamps;
- message and token counts when available;
- recorded parent session reference; and
- bounded direct child-session summaries from the viewer-owned session index.

It does not return the transcript. A missing session produces a typed
not-found error, while an unavailable provider produces a distinct
provider-unavailable error.

### 5.3 session_timeline

Pages through lightweight event summaries from one session. It is the single
general query primitive for messages, tool calls, and errors.

~~~json
{
  "session": { "provider": "opencode", "sessionId": "ses_123" },
  "segments": ["message", "tool"],
  "roles": ["assistant"],
  "toolNames": ["test"],
  "statuses": ["error"],
  "cursor": "opaque-cursor-from-previous-result",
  "limit": 50
}
~~~

All filters are optional. A summary contains EventRef, timestamp, role, tool
name/status when applicable, and a short preview. It never includes raw tool
input/output. The response has an opaque nextCursor and must remain stable for
the duration of one request sequence over unchanged source data.

Recorded system-role messages may be returned with a role filter. The tool must
not reconstruct hidden system prompts or read instruction files; those are
runtime-environment data, not session data.

### 5.4 session_get_context

Expands a specific EventRef into a limited same-session window. It accepts
before and after counts with a default of five and a maximum of twenty each.
The response is an ordered list of projected events and identifies the target.

The server must never cross into another session while constructing context,
including a parent or child session. An agent that needs a child session must
call session_get or session_timeline with that child SessionRef explicitly.

### 5.5 session_get_event

Returns one event precisely, with character paging for large content:

~~~json
{
  "event": {
    "provider": "codex",
    "sessionId": "thread_123",
    "messageId": "msg_456",
    "segment": "tool"
  },
  "includeToolInput": false,
  "includeToolOutput": true,
  "offset": 0,
  "maxChars": 4000
}
~~~

Message text is returned for a message segment. A thinking segment requires
includeThinking: true. A tool segment always returns its name and status, but
tool input and output require their explicit include flags. The maximum
returned character count is capped server-side and nextOffset is returned when
more content remains.

## 6. Retrieval And Indexing Strategy

### First implementation: adapter-backed keyword retrieval

Do not add a transcript database before the MCP contract is proven. The initial
search implementation:

1. obtains available adapters through getAvailableProviders();
2. filters them by the optional provider list;
3. calls each adapter's required searchMessages(query, perProviderLimit);
4. resolves matching sessions through getSession(sessionId);
5. merges content matches with title and recorded working-directory matches from the
   viewer-owned session index;
6. de-duplicates by the pair of provider and canonical session ID; and
7. ranks title matches before content matches, then orders by latest update.

The current ProviderAdapter.searchMessages() contract is synchronous. The
first implementation calls providers in a bounded loop, catches unavailable or
corrupt-provider failures, and records each search duration in diagnostics. It
cannot safely preempt one blocking adapter call without changing the provider
contract or isolating adapters in workers, neither of which belongs in this
release. If real-data timing is too slow, the FTS optimization below becomes a
release requirement rather than an optional follow-up.

### Session index refresh

The MCP process needs the same session-index freshness as the HTTP server.
Reuse the existing indexProvider(adapter) helper in src/index-db.ts, which
already scans an adapter and upserts its sessions. Refactor the duplicated
startup loop in src/server.ts to call that helper while preserving its
per-provider runtime logging and error isolation. The MCP entry point calls the
same helper before serving requests. This remains a viewer-owned metadata write
and never changes provider data.

session_get reads its child-session summaries from the indexed parent_id
relationship. It still asks the owning adapter for the selected session and
messages, so a stale index cannot fabricate a source session.

### Deferred optimization

If measured searches fail the acceptance target below, add a viewer-owned
incremental SQLite FTS index in a later milestone. It must contain only the
same default searchable fields, key entries by provider/session/message ID, and
be rebuilt from provider sources. It is an optimization, not a second source
of truth.

The direct-adapter acceptance target is a five-second p95 session_search result
on the supported real local provider datasets. If that target is not met, add
the viewer-owned FTS index before publishing the feature.

## 7. Transport, Configuration, And Logging

Build the MCP server as the AgentSession-MCP (`agentsession-mcp`) npm workspace
package in this repository. It
is independently installable and runs independently from the Viewer HTTP
process, but it is not a separate source repository.

Use the official TypeScript MCP SDK as a runtime dependency of
agentsession-mcp. A hand-written implementation of the evolving protocol would
be higher risk than one narrowly scoped dependency. The main
AgentSession (`agentsession`) Viewer package keeps its zero runtime dependency
constraint.

`AgentSession` and `AgentSession-MCP` are the display names; npm package names
and executable names use lowercase. The repository root is a private workspace
orchestrator. `packages/agentsession` packages the compiled Viewer output, and
`packages/agentsession-mcp` depends on the public `agentsession` exports. This
keeps the MCP SDK out of the Viewer runtime dependency set.

The package exposes this stdio binary:

~~~text
agentsession-mcp --config <same-config.json> [provider path options]
~~~

The normal user installation is:

~~~text
npm install -g agentsession-mcp
~~~

The AgentSession package publishes a small public session-history factory,
`agentsession/session-history`. The MCP package depends on that
public contract rather than importing private dist paths. Both packages release
from the same repository with the same major/minor version and a compatible
dependency range. Do not duplicate provider adapters or session normalization
inside the MCP package.

The entry point is a stdio server, not a route on the viewer's HTTP server:

- stdin and stdout are reserved for MCP JSON-RPC traffic;
- operational logs go only to stderr and existing viewer-owned runtime logs;
- it does not bind a TCP port;
- it reuses config parsing for the config path, OpenCode database, and Claude,
  Codex, and Gemini directories;
- it does not start browser UI, terminal launch, or analysis launch behavior.

Config support for MCP limits is new work. Add an optional mcp configuration
object to the existing JSON configuration, validate it in validateUserConfig(),
and preserve it through applyRuntimeUserConfig() with secure defaults:

~~~json
{
  "mcp": {
    "searchLimit": 20,
    "timelineLimit": 50,
    "eventMaxChars": 4000,
    "contextWindow": 5
  }
}
~~~

The MCP entry point may call parseArgs() to share path resolution. parseArgs()
creates the viewer metadata directory, which is required for the viewer-owned
index and is the only permitted initialization write. The entry point must not
call writeUserConfig(), settings routes, or any other configuration mutation
surface. Command-line limits are not needed in the first release.

## 8. Security And Privacy Requirements

- All five tools are read-only. There is no tool for launch, resume, write,
  delete, reindex, metadata mutation, or filesystem-path reads.
- Tool schemas reject arbitrary paths, run directories, SQL, shell fragments,
  and undeclared fields.
- Only registered adapters and their normalized contracts read provider data.
- Provider data-store paths and raw transcript file paths are never tool
  parameters or result fields.
- A session's recorded working directory may be returned as metadata or matched
  as a keyword, but it is never resolved, traversed, or read as a filesystem
  path by an MCP tool.
- Limit all search, timeline, context, and event output server-side.
- Keep reasoning and full tool input/output opt-in, as described above.
- Mark transcript output as untrusted session content in each structured
  response and in tool descriptions. No transcript field is executable.
- Continue honoring viewer-owned excluded-session metadata. A session the user
  permanently excluded from the viewer must not be surfaced by the MCP server.
  Implement this through src/meta.ts getExcludedIds(provider), and use that
  metadata only as an access filter.

This does not promise to detect every secret that an agent wrote into a
transcript. The caller already runs locally with access to the configured
provider stores. The controls prevent accidental broad disclosure; they do not
turn session history into a secret vault.

## 9. Implementation Work Breakdown

### Phase 1: Shared primitives

1. Reuse indexProvider(adapter) from src/index-db.ts in the MCP process and
   refactor src/server.ts to use the same helper for its current session scan.
2. Add src/session-history.ts with SessionRef/EventRef validation, normalized
   event projection, offset/limit paging, bounded strings, provider
   diagnostics, and excluded-session filtering.
3. Add narrow index-db helpers for title/directory matching and direct child
   lookup. Do not let the MCP layer execute arbitrary SQL.

### Phase 2: Session-history service

1. Implement the five service methods behind a dependency-injected provider
   registry and viewer metadata access.
2. Build cross-provider keyword merge/ranking on top of adapter.searchMessages
   and indexed title/directory lookup.
3. Verify each service path uses canonical provider IDs and does not make
   provider-specific assumptions.

### Phase 3: MCP adapter and executable

1. Add a public session-history factory export to the main Viewer package. It
   is provider-neutral, starts no HTTP server, and has no MCP SDK dependency.
2. Add packages/agentsession-mcp with the package manifest, MCP SDK dependency,
   stdio entry point, and the five tool definitions.
3. Add packages/agentsession-mcp/src/session-history-server.ts with the five MCP tool definitions,
   input/output schemas, read-only annotations, structured result mapping, and
   opaque service cursor handling.
4. Extend config validation with the optional mcp limit object and document
   manual client configuration for Codex, Claude Code, and other stdio MCP
   clients.
5. Keep server.ts free of MCP transport concerns. It only shares provider
   indexing and configuration primitives.

### Phase 4: Tests, documentation, and release verification

1. Add focused unit tests for references, event projections, cursor handling,
   bounds, excluded sessions, and unavailable providers.
2. Add adapter fixtures covering message-only, thinking, tool success, tool
   error, nested-session, and corrupt-source cases.
3. Start the compiled MCP binary in a protocol integration test. Verify
   initialize, tools/list, and a call to every tool, including JSON Schema
   validation and stdout cleanliness.
4. Use a real local provider dataset to verify cross-provider discovery,
   canonical session lookup, bounded tool output, and excluded-session behavior.
5. Update README.md, README.en.md, CLI help, package metadata, and provider
   contribution documentation when the feature is implemented.

## 10. Source Change Map

| File | Planned change |
|:---|:---|
| package.json | Private workspace orchestrator and shared build/test scripts; do not add the MCP SDK here. |
| packages/agentsession/package.json | Published AgentSession package manifest, binaries, and public session-history/config exports. |
| src/config.ts | Validate and apply MCP output-limit settings. |
| src/server.ts | Replace the duplicated startup scan/upsert loop with indexProvider(adapter). |
| src/index-db.ts | Reuse indexProvider(adapter) and add narrowly scoped index queries needed by session history. |
| src/meta.ts | Read excluded-session IDs as an MCP access filter only. |
| src/session-history.ts | New provider-neutral service and event projection layer. |
| packages/agentsession-mcp/package.json | New published agentsession-mcp package manifest, MCP SDK dependency, and binary declaration. |
| packages/agentsession-mcp/src/cli.ts | New stdio-only process entry point. |
| packages/agentsession-mcp/src/session-history-server.ts | New MCP protocol adapter and five tool schemas. |
| test/mcp.test.mjs | New protocol and service integration coverage. |
| README.md, README.en.md, docs/CONTRIBUTING-PROVIDER.md | Document AgentSession branding and the implemented user-facing MCP contract. |

No provider adapter should need an MCP-specific method in the first release.
The existing required getSession, getMessages, and searchMessages contract is
the compatibility baseline. A provider that cannot meet the event identity or
search guarantees should report partial capability through diagnostics rather
than silently fabricate results.

## 11. Acceptance Criteria

The implementation is complete only when all of the following hold:

- The compiled stdio server lists exactly the five session-history tools.
- All tools accept only structured references and bounded pagination values.
- A search spans every available registered provider and survives one provider
  failure with an explicit diagnostic.
- A returned SessionRef resolves through the provider's canonical ID.
- Timeline, event, and context results contain only the requested session.
- Tool outputs, reasoning, and long text are omitted or bounded by default.
- On real local provider datasets, direct-adapter session_search meets the
  five-second p95 target or the implementation includes the deferred FTS index.
- An excluded viewer session is absent from every MCP tool result.
- No provider-owned database or transcript changes after MCP startup and tool
  calls.
- No tool call starts a terminal, launches analysis, changes settings, edits
  metadata, or accepts a filesystem path.
- Type checking, the full test suite, MCP protocol tests, and a real local
  multi-provider smoke test pass.

## 12. Future Work, Explicitly Deferred

After the keyword-search contract has real usage data:

1. Add a viewer-owned incremental FTS index if direct provider search misses
   the latency target.
2. Add semantic retrieval only with opt-in local embeddings and clear storage
   policy.
3. Add a knowledge graph only for evidence-backed relationships such as
   session-to-session parentage, session-to-project, tool usage, and
   explicitly cited file/symbol mentions. Every graph edge must retain source
   EventRef values and confidence; it must not become an untraceable summary
   store.

The public MCP tool set should remain session-centric even when those
optimizations exist.
