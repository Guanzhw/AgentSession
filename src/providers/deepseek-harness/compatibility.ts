/** Checked-in compatibility evidence for the newest official DSH release. */
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
  commit: "dd6322d604e00eec1ba5e0c8541159906a21094a",
  tag: "dsh-v0.1.2-alpha.3",
  npm: Object.freeze({
    package: "@deepseek-ai/dsh",
    current: "0.1.2-alpha.3"
  }),
  sessionFormatVersion: 0,
  // SQLite schema 17 belonged to the previous backend. Alpha.3 removed the
  // session-persistence-sqlite plugin, so the current snapshot has no schema.
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
    eventCatalog: "packages/core/session/src/known-event-types.ts"
  }),
  fixture: Object.freeze({
    provenance: "derived-current-shape",
    commit: "dd6322d604e00eec1ba5e0c8541159906a21094a",
    local: "test/fixtures/dsh-alpha3-storage.jsonl"
  })
});

export type DshCompatibilitySnapshot = typeof DSH_COMPATIBILITY_SNAPSHOT;
