# Contributing a New Provider

This is the implementation guide for adding a local AI coding-agent session
provider to AgentSession. A provider reads and normalizes its own session data;
it must never modify the provider-owned database or transcript files.

`src/providers/interface.ts` is authoritative. Treat this document as the
end-to-end checklist that makes the TypeScript contract usable in the viewer,
the read-only MCP server, and a release.

## A complete Provider

A complete Provider is more than a parser. It must:

1. detect its local data without writing to it;
2. preserve canonical session IDs and parent relationships;
3. expose normalized sessions, messages, token statistics, and search;
4. register with the viewer and, when supported, AgentSession-MCP;
5. declare only capabilities it actually implements; and
6. include fixture, unavailable-data, and real-data verification.

Keep defaults, schema extraction, transcript quirks, resume behavior,
structured views, and runtime-environment discovery under
`src/providers/<provider-id>/`. Do not add central
`if (provider.id === "my-tool")` branches.

## Pick the correct reference implementation

Read the actual adapter before copying it. Choose by source data shape rather
than product similarity.

| Source data | Start with | Key pattern |
|---|---|---|
| One JSON session per file | `src/providers/gemini/` | File store, incremental token statistics, and flat structured views. |
| JSONL transcript | `src/providers/claude-code/` or `src/providers/codex/` | Defensive record parsing and explicit response/child-session boundaries. |
| In-file branch-tree JSONL | `src/providers/pi/` | Reconstruct the active `id`/`parentId` branch before normalizing messages; preserve file-level `parentSession` fork identity. |
| OpenCode-compatible SQLite | `src/providers/opencode/` and `src/providers/shared/sqlite-adapter.ts` | Share only schema-neutral SQLite behavior; keep schema enrichment provider-owned. |
| Nested/sidechain agent transcripts | `src/providers/shared/linked-message-session.ts` | Canonical `parentId` plus explicit spawn references. |

For file-backed sources, prefer `createSessionFileStore()`,
`createStructuredViewCache()`, `createStructuredViewMethods()`, and
`createIncrementalTokenStats()` from
`src/providers/shared/file-adapter-helpers.ts`. They avoid reparsing unchanged
files and keep detail views consistent.

## Non-negotiable data rules

- Provider data is read-only. Stars, custom titles, trash, and exclusions are
  AgentSession metadata, never source-data writes.
- A session ID remains canonical in scan results, lookup, URLs, metadata,
  exports, resume commands, analysis runs, parent links, and MCP requests.
- Use Unix milliseconds. A corrupt individual file must not block other
  sessions; retain a useful diagnostic and return `null`/empty arrays at
  optional boundaries.
- Normalize raw records at the parser/adapter boundary. Browser code must not
  know the provider's source schema.
- Reveal System Prompts and runtime configuration only from resolvable local
  evidence. Never claim to recover hidden provider prompts.

## The ProviderAdapter contract

Every adapter must provide `id`, `name`, `icon`, `detect()`,
`getDataPath()`, `scan()`, `getSession()`, `getMessages()`,
`getTokenStats()`, and `searchMessages()`.

| Member | Required behavior |
|---|---|
| `id` | Stable lowercase ID. Add it to `ProviderId` first. |
| `detect()` | True only when locally configured source data is usable. |
| `scan()` / `getSession()` | Canonical `RawSession` records; use `parentId: null` when there is no parent. |
| `getMessages()` | Full normalized `Message[]`, including every required nullable field. |
| `getTokenStats(days)` | Daily trusted aggregates, or `[]` when unavailable. Do not double count fragmented responses. |
| `searchMessages()` | Bounded snippets associated with canonical session and message IDs. |

### Normalize all nullable fields

`RawSession.parentId` is required even for a flat history. `Message` fields such
as `thinking`, `toolName`, `toolInput`, `toolOutput`, `tokens`, and `metadata`
are also required by the TypeScript type; use `null`, not omission.

```ts
import type { Message, RawSession } from "../interface.js";

export function normalizeSession(raw: any): RawSession {
  return {
    id: String(raw.sessionId),
    provider: "my-tool", // Valid after ProviderId is extended.
    parentId: raw.parentSessionId ? String(raw.parentSessionId) : null,
    title: typeof raw.title === "string" ? raw.title : null,
    directory: typeof raw.cwd === "string" ? raw.cwd : null,
    timeCreated: Number(raw.createdAt) || 0,
    timeUpdated: Number(raw.updatedAt) || 0,
    messageCount: Array.isArray(raw.messages) ? raw.messages.length : 0,
    tokenCount: Number.isFinite(raw.totalTokens) ? Number(raw.totalTokens) : null,
    metadata: null
  };
}

export function normalizeMessage(raw: any, sessionId: string): Message {
  return {
    id: String(raw.id),
    sessionId,
    role: raw.role === "user" ? "user" : "assistant",
    content: typeof raw.text === "string" ? raw.text : "",
    thinking: typeof raw.thinking === "string" ? raw.thinking : null,
    toolName: typeof raw.toolName === "string" ? raw.toolName : null,
    toolInput: raw.toolInput ?? null,
    toolOutput: raw.toolOutput ?? null,
    timestamp: Number(raw.timestamp) || 0,
    tokens: raw.tokens
      ? { input: Number(raw.tokens.input) || 0, output: Number(raw.tokens.output) || 0 }
      : null,
    metadata: raw.turnId ? { turnId: String(raw.turnId) } : null
  };
}
```

When one response is fragmented into reasoning, text, tool call, and tool
result records, give those fragments the same `metadata.turnId` (or
`responseGroupId`). A group must never cross assistant-response boundaries.

### Capabilities and optional methods

Capabilities are declarations, not feature requests. Declare one only when the
implementation and tests support it.

| Capability or method | Use it when |
|---|---|
| `localManagement` | Canonical session IDs are stable enough for viewer metadata. It never authorizes source writes. |
| `sqliteSessionStore` | The provider uses the compatible SQLite session-store behavior. |
| `sessionAnalysis` | A provider-owned analysis launch and validation path exists. |
| `structuredSessionViews` | All four methods exist: `getSessionTree`, `getSessionContainer`, `getSessionMetrics`, and `getSessionFlow`. |
| `resumeCommand` | A safe structured executable/argument command with `{sessionId}` and `{directory}` placeholders is known. |
| `getStatsRevision()` | A file-backed source can report changed statistics input. |
| `getRuntimeEnvironment()` | Locally resolvable instruction/skill/agent/command/plugin/hook/rule evidence exists. |
| `getSystemPrompts()` / `getTrace()` | Provider-owned, evidence-backed prompt or trace views exist. |

For flat histories, compose `buildMessageSessionViews()` with
`createStructuredViewMethods()`. For child sessions, use the linked-session
helper instead of guessing from display order.

## End-to-end change checklist

### 1. Define the ID and path boundary

- [ ] Add the stable lowercase ID to `ProviderId` in
  `src/providers/interface.ts`.
- [ ] Add a default data-path resolver and configuration field in
  `src/config.ts` if users need to configure the provider root.
- [ ] When the path is configurable, add its CLI flag, help text, environment
  variable, config validation, and both README entries.
- [ ] Add an icon in `src/icons.ts`.

### 2. Create a provider-owned parser and adapter

Create `src/providers/my-tool/`. It normally contains:

```text
src/providers/my-tool/
├── adapter.ts              # Detection, paths, capabilities, public methods
├── parser.ts               # Raw schema to RawSession/Message normalization
└── runtime-environment.ts  # Only when local runtime evidence is resolvable
```

Use `node:fs`, `node:path`, and `node:os`. Catch parse errors per source file,
not around the whole provider scan. Use `satisfies ProviderAdapter` on the
adapter object so the contract is checked during typecheck.

The adapter shape should follow this pattern; its store, views, token mapping,
and search stay provider-owned:

```ts
const myTool = {
  id: "my-tool",
  name: "My Tool CLI",
  icon: icons.myTool,
  resumeCommand: { executable: "my-tool", args: ["resume", "{sessionId}"] },
  capabilities: { localManagement: true, structuredSessionViews: true },
  detect: () => existsSync(path.join(getMyToolDir(), "sessions")),
  getDataPath: () => getMyToolDir(),
  async *scan() { for (const entry of sessionFiles.list()) yield entry.session; },
  getSession: (id: string) => sessionFiles.get(id)?.session || null,
  getMessages: (id: string) => sessionFiles.get(id)?.messages || [],
  ...createStructuredViewMethods(getViews),
  getTokenStats: (days = 30) => getMyToolTokenStats(days),
  getStatsRevision: () => sessionFiles.getStatsRevision(),
  searchMessages: (query: string, limit = 20) => searchMyToolMessages(query, limit)
} satisfies ProviderAdapter;
```

### 3. Register the viewer

- [ ] Import the adapter and call `registerProvider(myTool)` in
  `src/providers/index.ts`.
- [ ] Confirm `getAllProviders()` contains it while unavailable and
  `getAvailableProviders()` contains it only after `detect()` succeeds.
- [ ] Keep provider-specific parsing and views out of shared routes and views.

### 4. Register MCP ID validation

AgentSession-MCP deliberately validates Provider IDs. A newly registered viewer
Provider is not MCP-queryable until both of these are updated:

- [ ] Extend `PROVIDER_IDS` in `src/session-history.ts`.
- [ ] Extend the Zod `providerSchema` in
  `packages/agentsession-mcp/src/session-history-server.ts`.
- [ ] Test that `session_search`, `session_get`, and one event/context call
  accept the new ID while results remain read-only and transcript content stays
  marked untrusted.

Do not add analysis launch, terminal launch, or mutation tools to this MCP
server.

### 5. Add optional runtime and analysis support only when justified

Implement `getRuntimeEnvironment()` only when the adapter can resolve current
local evidence and source paths. It must not imply that hidden historical
instructions were recovered.

Set `sessionAnalysis` only after provider-owned launch configuration, bounded
runtime capture, and the validator lifecycle in
`docs/ANALYSIS-PROVIDER-IMPLEMENTATION.md` are in place. A provider is useful
without analysis support.

### 6. Update public documentation

- [ ] Add the provider, source path, and truthful capabilities to the support
  table in `README.md` and `README.en.md`.
- [ ] Update CLI/config/environment and resume-command examples when relevant.
- [ ] Update this guide when the contract, capability model, or MCP registration
  boundary changes.

## Test and acceptance matrix

Use small provider-owned fixtures. Do not rely only on one contributor's local
data directory.

| Surface | Required evidence |
|---|---|
| Parser | Current and legacy shapes; canonical ID; `parentId`; timestamps; every nullable Message field; tools/reasoning/models/tokens when present. |
| Corruption and cache | One malformed file is skipped; unchanged files are reused; changed files reparse; deleted files disappear. |
| Adapter | Absent-data `detect()`; scan/get/messages/search agreement; token fragments are not double counted. |
| Nested agents | Explicit child IDs link correctly; copied parent context does not become child content; multiple children do not cross-contaminate. |
| Capabilities | Every declared capability has a matching view, resume, runtime, or analysis test. |
| Viewer routes | Unavailable state, detail, search, metadata management, and structured views work without central provider-ID branches. |
| MCP | Both static validators accept the ID; the five read-only tools remain bounded and untrusted-content safe. |
| Real data | Scan a real source, inspect a detail API/page, and report source path plus observed session/message counts. |

Run at least:

```powershell
npm run typecheck
npm test

# For user-visible behavior, with a compatible local server running:
npm run qa:e2e
```

For release-quality work, restart AgentSession, call `GET /api/providers`, and
exercise both unavailable and installed states against a real source. Follow
the validation matrix in `AGENTS.md` for the changed surface.

## Pull request checklist

- [ ] Provider data remains read-only.
- [ ] IDs stay canonical across viewer, metadata, resume, analysis, and MCP.
- [ ] Provider-specific code stays under `src/providers/<id>/`; shared helpers
  remain schema-neutral.
- [ ] Required adapter methods and nullable normalized fields are present.
- [ ] Capabilities exactly match implemented behavior.
- [ ] Config, CLI help, icons, registration, and both MCP allow lists were reviewed.
- [ ] Fixtures cover current, malformed, unavailable, and nested data as applicable.
- [ ] Real local data plus browser/API output were verified.
- [ ] English and Chinese README tables/examples are current.
- [ ] `git diff --check`, typecheck, and relevant tests pass.

## Related references

- `src/providers/interface.ts` — authoritative adapter contract.
- `src/providers/gemini/` — compact JSON file-provider example.
- `src/providers/claude-code/` and `src/providers/codex/` — JSONL and nested
  transcript examples.
- `src/providers/pi/` — in-file branch-tree JSONL, compaction, tool-result,
  usage, session-name, and forked-session example.
- `src/providers/shared/file-adapter-helpers.ts` — file-store, token, and
  structured-view helpers.
- `src/providers/shared/linked-message-session.ts` — nested session linking.
- `src/providers/shared/sqlite-adapter.ts` — schema-neutral SQLite helpers.
- `src/session-history.ts` and
  `packages/agentsession-mcp/src/session-history-server.ts` — MCP ID boundary.
- `docs/ANALYSIS-PROVIDER-IMPLEMENTATION.md` — analysis integration.
