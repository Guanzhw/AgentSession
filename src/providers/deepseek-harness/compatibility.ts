/**
 * Checked-in compatibility evidence for the newest official DSH release.
 *
 * Refresh 2026-09-08 (alpha.2): tag `dsh-v0.1.3-alpha.2`, commit
 * `82a5fd61a7cf5c293cec4bdff68f455398d685e9`. This is the first released
 * Session format v2 snapshot: v0/v1 retain their frozen seedLength + packed
 * rows, while v2 stores one event per JSONL row, uses isSeeded and tagged
 * end-seed inheritance, embeds Assistant streams, and admits the generated
 * alpha.2 event catalog. Reads are strictly read-only; no migration is
 * performed by AgentSession.
 */
const CURRENT_BASE_REQUIRED_EVENT_TYPES = Object.freeze([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/asked",
  "approval/decided",
  "approval/policy",
  "assistant/message",
  "assistant/attempt",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "compaction/summary",
  "feedback/record",
  "feedback/message-put",
  "feedback/message-delete",
  "goal/change",
  "hook/invoked",
  "hook/result",
  "llm/retry",
  "llm/retry-started",
  "permission/preset",
  "plan/mode",
  "request/context",
  "request/header",
  "sandbox/mode",
  "schedule/change",
  "session/end-seed",
  "session/title",
  "session/title-llm-request",
  "step/end",
  "step/start",
  "subagent/descriptor",
  "team/member",
  "team/message/delivered",
  "team/message/queued",
  "team/task",
  "todo/write",
  "tool-workflow/agent-end",
  "tool-workflow/agent-start",
  "tool-workflow/run-end",
  "tool-workflow/run-start",
  "tool/call",
  "tool/code-dispatch",
  "tool/code-dispatch-start",
  "tool/result",
  "turn/end",
  "turn/start",
  "user/message",
  "web/deepseek-search-llm-request"
]);

// The alpha.2 generated catalog includes the model/log-delivery facts below;
// this bounded list is checked against the official known-event-types source.
const CURRENT_REQUIRED_EVENT_TYPES = Object.freeze([
  ...CURRENT_BASE_REQUIRED_EVENT_TYPES,
  "model/selection",
  "session-log-deepseek/delivery-accepted",
  "subagent/model-selection-policy"
]);
const LEGACY_REQUIRED_EVENT_TYPES = Object.freeze([
  ...CURRENT_BASE_REQUIRED_EVENT_TYPES.filter((type) => type !== "assistant/attempt" && type !== "feedback/message-put" && type !== "feedback/message-delete"),
  "assistant/chunk"
]);

const JSONL_LAYOUT = Object.freeze({
  rawSuffix: ".jsonl",
  compressedSuffix: ".jsonl.zstd",
  packedRows: Object.freeze(["text-chunks", "reasoning-chunks", "tool-call-chunks"]),
  rangeEncodedSourceEventSeqs: true
});

export const DSH_COMPATIBILITY_SNAPSHOT = Object.freeze({
  repository: "deepseek-ai/deepseek-harness",
  // alpha.2 tag commit.
  commit: "82a5fd61a7cf5c293cec4bdff68f455398d685e9",
  // Official repository HEAD at the verified alpha.2 tag.
  headCommit: "82a5fd61a7cf5c293cec4bdff68f455398d685e9",
  tag: "dsh-v0.1.3-alpha.2",
  npm: Object.freeze({
    package: "@deepseek-ai/dsh",
    current: "0.1.3-alpha.2"
  }),
  sessionFormatVersion: 2,
  // Alpha.2 still ships no session-persistence SQLite plugin. The SQLite
  // packages that exist are a storage-hub kv facet and an FTS5 session-query
  // backend, not session persistence. Schema 17 remains the last legacy
  // persistence schema (previousRelease) for existing stores.
  sqliteSchemaVersion: null,
  previousRelease: Object.freeze({
    package: "@deepseek-ai/dsh",
    version: "0.1.1-rc.2",
    commit: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
    tag: "dsh-v0.1.1-rc.2",
    sessionFormatVersion: 0,
    sqliteSchemaVersion: 17,
    requiredEventTypes: LEGACY_REQUIRED_EVENT_TYPES
  }),
  // The snapshot tracked before this refresh. Its fixture is a derived
  // current-shape log (the official alpha.3 snapshot is not checked in
  // upstream as raw storage), and it remains a readability regression.
  previousSnapshot: Object.freeze({
    tag: "dsh-v0.1.2-alpha.3",
    commit: "dd6322d604e00eec1ba5e0c8541159906a21094a",
    package: "@deepseek-ai/dsh",
    version: "0.1.2-alpha.3",
    sessionFormatVersion: 0,
    sqliteSchemaVersion: null,
    requiredEventTypes: CURRENT_REQUIRED_EVENT_TYPES,
    fixture: Object.freeze({
      provenance: "derived-current-shape",
      commit: "dd6322d604e00eec1ba5e0c8541159906a21094a",
      local: "test/fixtures/dsh-alpha3-storage.jsonl"
    })
  }),
  legacyFixture: Object.freeze({
    tag: "dsh-v0.1.0-rc.8",
    source: "apps/web/tests/snapshots/fresh-round-trip/session.jsonl",
    commit: "141eb6fef83422698aef7a981029e843e8161534",
    local: "test/fixtures/dsh-rc8-fresh-round-trip.jsonl"
  }),
  jsonl: JSONL_LAYOUT,
  requiredEventTypes: CURRENT_REQUIRED_EVENT_TYPES,
  upstreamReferences: Object.freeze({
    sessionSnapshot: "snapshots/web/fresh-round-trip/session.jsonl",
    sequenceCodec: "packages/core/session/src/seq-ranges.ts",
    eventCatalog: "packages/core/session/src/known-event-types.ts",
    // The web snapshot omits event envelopes; upstream seeds it through
    // parseSessionLog, which synthesizes seq (order, packed rows expanded
    // after their row) and time (0). The fixture regression reproduces that
    // rule instead of hand-editing official bytes.
    fixtureEnvelopeRule: "packages/test-support/llm-replay/src/index.ts (parseSessionLog)"
  }),
  fixture: Object.freeze({
    provenance: "official-checked-in-web-snapshot",
    formatVersion: 0,
    sourceRelease: "dsh-v0.1.2-alpha.5",
    commit: "db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5",
    local: "test/fixtures/dsh-alpha5-fresh-round-trip.jsonl",
    // sha256 of the retained local v0 fixture, identical to the upstream
    // alpha.5 checked-in web snapshot from which this historical evidence came.
    sha256: "0747344224d4222f861dd9692c4332badfba221afc6e686c3dee18177055d845",
    envelopeOmitted: "web fixtures omit seq/time; synthesised on read per upstream parseSessionLog",
    upstreamSource: "snapshots/web/fresh-round-trip/session.jsonl"
  })
});

export type DshCompatibilitySnapshot = typeof DSH_COMPATIBILITY_SNAPSHOT;
