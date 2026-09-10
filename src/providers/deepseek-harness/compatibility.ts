/**
 * Checked-in compatibility evidence for the newest official DSH release.
 *
 * Refresh 2026-09-10: tag `dsh-v0.1.5-alpha.2`, commit
 * `b2e3b2a0125854567a4a5fcba75782e42fe84901`. Native Session format v3 keeps
 * v0/v1/v2 readable and adds system/message surfaces, canonical replacement
 * coordinates, and PTC vocabulary. Reads are strictly read-only; no migration
 * is performed by AgentSession.
 */
const V2_BASE_REQUIRED_EVENT_TYPES = Object.freeze([
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

const V2_REQUIRED_EVENT_TYPES = Object.freeze([
  ...V2_BASE_REQUIRED_EVENT_TYPES,
  "model/selection",
  "session-log-deepseek/delivery-accepted",
  "subagent/model-selection-policy"
]);
// V3 preserves the V2 catalog except for the exact code-to-PTC rename and the
// three newly recorded event kinds.
const CURRENT_REQUIRED_EVENT_TYPES = Object.freeze([
  ...V2_BASE_REQUIRED_EVENT_TYPES.filter((type) => type !== "tool/code-dispatch" && type !== "tool/code-dispatch-start"),
  "deliverables/presented",
  "subagent/catalog",
  "system/message",
  "tool/ptc-dispatch",
  "tool/ptc-dispatch-start",
  "model/selection",
  "session-log-deepseek/delivery-accepted",
  "subagent/model-selection-policy"
]);
const LEGACY_REQUIRED_EVENT_TYPES = Object.freeze([
  ...V2_BASE_REQUIRED_EVENT_TYPES.filter((type) => type !== "assistant/attempt" && type !== "feedback/message-put" && type !== "feedback/message-delete"),
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
  commit: "b2e3b2a0125854567a4a5fcba75782e42fe84901",
  // Official repository HEAD at the verified alpha.2 tag.
  headCommit: "b2e3b2a0125854567a4a5fcba75782e42fe84901",
  tag: "dsh-v0.1.5-alpha.2",
  npm: Object.freeze({
    package: "@deepseek-ai/dsh",
    current: "0.1.5-alpha.2"
  }),
  sessionFormatVersion: 3,
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
    requiredEventTypes: V2_REQUIRED_EVENT_TYPES,
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
    sessionSnapshot: "packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/--dsh-workspace--/preview-showcase/session.v3.jsonl",
    sequenceCodec: "packages/core/session/src/seq-ranges.ts",
    eventCatalog: "packages/core/session/src/known-event-types.ts",
    fixtureEnvelopeRule: "native v3 fixture stores complete seq/time event envelopes"
  }),
  fixture: Object.freeze({
    provenance: "official-checked-in-v3-fixture",
    formatVersion: 3,
    sourceRelease: "dsh-v0.1.5-alpha.2",
    commit: "b2e3b2a0125854567a4a5fcba75782e42fe84901",
    local: "test/fixtures/dsh-alpha15-v3-preview-showcase.jsonl",
    // sha256 of the retained local fixture, identical to the upstream source.
    sha256: "eb7ecaf5fdd8a2b95959ef9cc5eebba5761848f014e4e1a99eaf6134515898cb",
    upstreamSource: "packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/--dsh-workspace--/preview-showcase/session.v3.jsonl"
  })
});

export type DshCompatibilitySnapshot = typeof DSH_COMPATIBILITY_SNAPSHOT;
