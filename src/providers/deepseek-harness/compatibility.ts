/**
 * Checked-in compatibility evidence for the DSH reader.
 *
 * This is deliberately source data, not a live version check.  Updating it is
 * an explicit maintenance operation when the official DSH format changes.
 */
export const DSH_COMPATIBILITY_SNAPSHOT = Object.freeze({
  repository: "deepseek-ai/deepseek-harness",
  commit: "141eb6fef83422698aef7a981029e843e8161534",
  tag: "dsh-v0.1.0-rc.8",
  npm: Object.freeze({
    package: "@deepseek-ai/dsh",
    stable: "0.1.0-rc.7",
    next: "0.1.0-rc.8"
  }),
  sessionFormatVersion: 0,
  sqliteSchemaVersion: 17,
  fixture: Object.freeze({
    source: "apps/web/tests/snapshots/fresh-round-trip/session.jsonl",
    commit: "141eb6fef83422698aef7a981029e843e8161534",
    local: "test/fixtures/dsh-rc8-fresh-round-trip.jsonl"
  }),
  jsonl: Object.freeze({
    rawSuffix: ".jsonl",
    compressedSuffix: ".jsonl.zstd",
    packedRows: Object.freeze(["text-chunks", "reasoning-chunks", "tool-call-chunks"])
  }),
  requiredEventTypes: Object.freeze([
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
  ])
});

export type DshCompatibilitySnapshot = typeof DSH_COMPATIBILITY_SNAPSHOT;
