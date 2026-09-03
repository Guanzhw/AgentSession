/**
 * Checked-in compatibility evidence for the newest official DSH release.
 *
 * Refresh 2026-09-03 (alpha.5): tag `dsh-v0.1.2-alpha.5`
 * `db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`, official HEAD
 * `49a606bc5b5934603f22a26957a07dc799ab0291`. The physical storage format is
 * unchanged from alpha.3: session format version `0`, the same generated
 * event catalog (`packages/core/session/src/known-event-types.ts`), a
 * `seedLength`-based header line (`toHeaderLine` still writes `seedLength`
 * for seeded logs; alpha.5 only split the in-memory `SessionHeader` into
 * `isSeeded` + a separately carried inherited-event count), identical packed
 * chunk-row shapes, and identical sequence-range and Zstd frame codecs.
 * Alpha.5 therefore requires no parser/protocol change; the alpha.3-derived
 * and rc.8 fixtures remain readable.
 */
const PREVIOUS_REQUIRED_EVENT_TYPES = Object.freeze([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/asked",
  "approval/decided",
  "approval/policy",
  "assistant/chunk",
  "assistant/message",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "compaction/summary",
  "feedback/record",
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

// The alpha.3 catalog already included the model/log-delivery facts; alpha.5
// keeps them. Set-comparison against the generated alpha.5 catalog passed.
const CURRENT_REQUIRED_EVENT_TYPES = Object.freeze([
  ...PREVIOUS_REQUIRED_EVENT_TYPES,
  "model/selection",
  "session-log-deepseek/delivery-accepted",
  "subagent/model-selection-policy"
]);

const JSONL_LAYOUT = Object.freeze({
  rawSuffix: ".jsonl",
  compressedSuffix: ".jsonl.zstd",
  packedRows: Object.freeze(["text-chunks", "reasoning-chunks", "tool-call-chunks"]),
  rangeEncodedSourceEventSeqs: true
});

export const DSH_COMPATIBILITY_SNAPSHOT = Object.freeze({
  repository: "deepseek-ai/deepseek-harness",
  // alpha.5 tag commit: dsh-v0.1.2-alpha.5.
  commit: "db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5",
  // Official repository HEAD when the snapshot was verified (merge that
  // carried the alpha.5 version to master).
  headCommit: "49a606bc5b5934603f22a26957a07dc799ab0291",
  tag: "dsh-v0.1.2-alpha.5",
  npm: Object.freeze({
    package: "@deepseek-ai/dsh",
    current: "0.1.2-alpha.5"
  }),
  sessionFormatVersion: 0,
  // Alpha.5 still ships no session-persistence SQLite plugin. The SQLite
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
    requiredEventTypes: PREVIOUS_REQUIRED_EVENT_TYPES
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
    commit: "db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5",
    local: "test/fixtures/dsh-alpha5-fresh-round-trip.jsonl",
    // sha256 of the checked-in fixture, identical to upstream's checked-in
    // snapshots/web/fresh-round-trip/session.jsonl at the tag and at HEAD.
    sha256: "0747344224d4222f861dd9692c4332badfba221afc6e686c3dee18177055d845",
    envelopeOmitted: "web fixtures omit seq/time; synthesised on read per upstream parseSessionLog",
    upstreamSource: "snapshots/web/fresh-round-trip/session.jsonl"
  })
});

export type DshCompatibilitySnapshot = typeof DSH_COMPATIBILITY_SNAPSHOT;
