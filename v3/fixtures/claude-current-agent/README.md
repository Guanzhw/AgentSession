# Current Claude Agent launch shape

This bounded public fixture derives its Agent input, structured asynchronous
toolUseResult and task-notification shape from an actual Claude Code 2.1.296
capture on 2026-10-11. Identifiers, timestamps, paths, text and surrounding
records are controlled test data. It is not an authentic transcript.

The result records `isAsync: true`, `status: async_launched`, and an exact
`agentId`. The separate sidechain records that agentId and its parent sessionId.
No successful AgentRun or result handoff is implied by the launch record.
